"""
scheduler.py — Class Timetable LP Solver (JSON in / JSON out)
Requires: pulp, pandas
=================================================================================
MATHEMATICAL FORMULATION SUMMARY
----------------------------------

SETS:
  B = set of buckets (section names in Sections mode, area.shortName in Areas mode)
  C   = set of course codes
  T_b = {0, …, n_b-1}  — ordered slot indices for bucket b
  F   = set of faculty short names
  PK  = set of period keys uniquely identifying each scheduling period:
        period_unit = "weeks" → pk = ISO year-week integer:
                                pk = iso_year * 100 + iso_week
                                Example: 2026-W10 → 202610
        period_unit = "days"  → pk = date.toordinal()
  G   = set of course conflict groups               [optional — H7]
  C_g = set of course codes in conflict group g
  B_g = set of buckets to which conflict group g applies

PARAMETERS:
  req[b,c]   = required number of sessions for (bucket b, course c) (in Areas mode req is aggregated / derived per course-bucket semantics)
  fac[b,c]   = faculty member assigned to teach course c in bucket b
  date[b,t]  = calendar date of slot t for bucket b
  pk[b,t]    = period key of slot t  (see PK definition above)
  bk[b,t]    = boundary key of slot t; controls where the consecutive counter resets:
                 reset_boundary = "month" → bk = date.year × 100 + date.month
                 reset_boundary = "none"  → bk = 0  (no reset, sequence is continuous)
  m_f        = maximum sessions faculty f may teach per calendar day
  unavail[f] = mapping of dates to unavailable time slots (set of from_time values); None indicates full-day unavailability  [optional — H6]
  M          = max_consecutive (integer ≥ 1, from constraintConfig)
               A window of (M+1) consecutive same-boundary periods triggers a penalty.

DECISION VARIABLES:
  x[b,c,t]   ∈ {0,1}  — 1 if bucket b is taught course c at slot t 
                        (in Sections mode there is exactly one course per (b,t); 
                        in Areas mode multiple x[b,c,t]=1 for a single (b,t) are allowed unless other constraints forbid them)
  y[scope,pk]  ∈ {0,1}  — 1 if bucket b has ≥ 1 session of course c in period pk
                        auxiliary presence variable for a scope in period pk where scope is:
                            - Sections mode: scope = (b,c) (bucket-course pair)
                            - Areas mode: scope = c (course-level scope)
  p[scope,pk0] ∈ {0,1}  — 1 if the window [pk0, pk0+1, …, pk0+M] is a consecutive violation for scope (scope is defined save as y)  (only created when consecutive rule enabled)

OBJECTIVE:
  Consecutive rule DISABLED → Minimize 0                      (pure feasibility)
  Consecutive rule ENABLED  → Minimize Σ_{scope,pk0} p[scope,pk0] (minimize violations)

FIXED HARD CONSTRAINTS (always applied):
  (H1) Session Fulfillment:
         Σ_t x[b,c,t] = req[b,c]    ∀ b ∈ B, c ∈ C

  (H2) At Most One Course per Slot (empty slots allowed in Sections mode):
      Σ_c x[b,c,t] ≤ 1   ∀ b, t  (enforced only when configMode == 'sections')
      [In Areas mode this constraint is not applied; areas may host parallel sessions.]

  (H3) No Faculty Cloning:
         Σ_{(b,c): fac[b,c]=f} x[b,c,t] ≤ 1     ∀ f, (date, fromTime)
         [a faculty member appears in at most one bucket at a given date+time]

  (H4) Maximum Daily Workload:
         Σ_{(b,c,t): date[b,t]=d, fac[b,c]=f} x[b,c,t] ≤ m_f    ∀ f, d

  (H5) Daily Course Spacing:
         Σ_{t: date[b,t]=d} x[b,c,t] ≤ 1    ∀ b, c, d

OPTIONAL HARD CONSTRAINTS (toggled via constraintConfig):
  (H6) Faculty Unavailability:
         x[b,c,t] = 0   if slot (date[b,t], fromTime[b,t]) ∈ unavail[fac[b,c]]
                        OR if date[b,t] is fully blocked for that faculty

  (H7) Course Conflict Groups:
         Σ_{c ∈ C_g, b ∈ B_g, t: (date[b,t], ft[b,t]) = (d, ft)} x[b,c,t] ≤ 1
         ∀ g, (d, ft)
         [courses in the same group may not run at the same date+time (for affected sections in Sections mode, across all areas in Areas mode)]

SOFT CONSTRAINT — Consecutive Sessions Rule (when enabled):
  Auxiliary constraints linking y ↔ x (applied using the chosen scope):
  (A1) y[scope,pk] ≥ x[b,c,t]                      ∀ b,c,t  where pk[b,t] = pk and scope applies
       [y is forced to 1 if any session exists in period pk]
  (A2) y[scope,pk] ≤ Σ_{t: pk[b,t]=pk and scope applies} x[b,c,t]   ∀ b, c, pk
       [y is forced to 0 if no sessions exist in period pk]

  Window eligibility — a window W = [pk0, pk0+1, …, pk0+M] is eligible for a given scope iff:
    (i)  All M+1 period keys exist in the set of period slots relevant to that scope, AND
    (ii) All M+1 period keys share the same boundary key bk  (when reset_boundary ≠ "none")
         [sequences do not carry over across month boundaries, etc.]

  Penalty activation:
  (P)  p[scope,pk0] ≥ Σ_{pk ∈ W} y[scope,pk] - M    ∀ eligible windows W
       When all M+1 y-values equal 1 → RHS = 1, so p is forced to 1 (violation counted).
       When fewer than M+1 y-values equal 1 → RHS ≤ 0, constraint is slack (p stays 0).
"""

import pulp
import pandas as pd
from datetime import date, datetime, timedelta
from collections import defaultdict
from typing import Any, cast


#  helpers 
def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()

def _generate_bucket_calendar(buckets, start_date, end_date, name_key, excluded_dates_key=None):
    """Build an ordered slot calendar for each schedule bucket.

    Buckets are either sections or areas. Areas may also exclude specific dates.
    """
    WEEKDAY = {
        "Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
        "Friday": 4, "Saturday": 5, "Sunday": 6,
    }
    calendar = {}
    for bucket in buckets:
        bucket_name = bucket[name_key]
        excluded_dates = set()
        if excluded_dates_key:
            excluded_dates = {_parse_date(d) for d in bucket.get(excluded_dates_key, [])}

        slot_defs = [
            (WEEKDAY[slot["weekday"]], slot["fromTime"], slot["toTime"], float(slot["duration"]))
            for slot in bucket["slots"]
        ]

        slots = []
        cur = start_date
        while cur <= end_date:
            if cur not in excluded_dates:
                wd = cur.weekday()
                for (wd_num, ft, tt, dur) in slot_defs:
                    if wd == wd_num:
                        slots.append({
                            "date": cur,
                            "weekday": cur.strftime("%A"),
                            "from_time": ft,
                            "to_time": tt,
                            "duration": dur,
                            "time_label": f"{ft} – {tt}",
                        })
            cur += timedelta(days=1)
        slots.sort(key=lambda x: (x["date"], x["from_time"]))
        calendar[bucket_name] = slots
    return calendar


#  main solver 
def _solve(data):
    """
    Build and solve the ILP.

    Returns a result dict:
      status          : "optimal" | "infeasible" | "error"
      constraint_type : "hard" | "soft"
      penalty         : int   (0 for hard)
      timetable       : list of session dicts
      message         : human-readable note
    """
    _ccfg = data.get("constraintConfig", {})
    _crule = _ccfg.get("consecutiveRule", {})
    apply_unavail = _ccfg.get("facultyUnavailability", True)
    apply_conflicts = _ccfg.get("courseConflicts", True)
    consec_enabled = _crule.get("enabled", True)
    max_consecutive = max(1, int(_crule.get("maxConsecutive", 2)))
    period_unit = _crule.get("periodUnit", "weeks")
    reset_boundary = _crule.get("resetBoundary", "month")

    start_date = _parse_date(data["startDate"])
    end_date = _parse_date(data["endDate"])

    mode = data.get("configMode", "sections")
    area_mode = mode == "areas"

    bucket_cfgs = data.get("areas", []) if area_mode else data.get("sections", [])
    bucket_name_key = "shortName" if area_mode else "name"
    bucket_names = [b[bucket_name_key] for b in bucket_cfgs]
    bucket_set = set(bucket_names)

    courses_cfg = data["courses"]
    faculty_cfg = data["faculty"]
    mappings_cfg = data["mappings"]

    COURSES = [c["code"] for c in courses_cfg]

    course_meta = {c["code"]: c for c in courses_cfg}
    faculty_meta = {f["shortName"]: f for f in faculty_cfg}

    required = {}
    faculty_map = {}
    errors = []

    if area_mode:
        course_to_faculty = {}
        for m in mappings_cfg:
            code = m["courseCode"]
            fac = m["facultyShortName"]
            if code in course_to_faculty and course_to_faculty[code] != fac:
                errors.append(f"Course {code}: multiple faculty mappings in area mode")
            course_to_faculty[code] = fac

        for course in courses_cfg:
            code = course["code"]
            area = course.get("areaShortName", "").strip()
            if not area:
                errors.append(f"Course {code}: missing areaShortName")
                continue
            if area not in bucket_set:
                errors.append(f"Course {code}: unknown area {area}")
                continue
            if code not in course_to_faculty:
                errors.append(f"Course {code}: missing faculty mapping")
                continue
            key = (area, code)
            required[key] = int(course_meta[code]["requiredSlots"])
            faculty_map[key] = course_to_faculty[code]
    else:
        for m in mappings_cfg:
            bucket = m["section"]
            code = m["courseCode"]
            if bucket not in bucket_set:
                errors.append(f"Section {bucket}: unknown section in mapping for {code}")
                continue
            if code not in course_meta:
                errors.append(f"Unknown course {code} in mapping")
                continue
            key = (bucket, code)
            if key in required:
                errors.append(f"Duplicate mapping for section {bucket} and course {code}")
                continue
            required[key] = int(course_meta[code]["requiredSlots"])
            faculty_map[key] = m["facultyShortName"]

    valid_pairs = set(faculty_map.keys())

    # Build faculty unavailability as a mapping: faculty -> {date: set(of from_times or None for whole-day)}
    unavail = {}
    for f in faculty_cfg:
        short = f["shortName"]
        m = defaultdict(set)
        # legacy full-day unavailable dates
        for d in f.get("unavailableDates", []):
            try:
                m[_parse_date(d)].add(None)
            except Exception:
                continue
        # new slot-level unavailability entries: list of {date, fromTime, toTime}
        for s in f.get("unavailableSlots", []):
            try:
                if isinstance(s, dict) and s.get("date"):
                    dt = _parse_date(s.get("date"))
                    ft = s.get("fromTime", "")
                    m[dt].add(ft)
            except Exception:
                continue
        unavail[short] = m

    max_load = {f["shortName"]: int(f.get("maxLoadPerDay", 2)) for f in faculty_cfg}

    calendar = _generate_bucket_calendar(
        bucket_cfgs,
        start_date,
        end_date,
        bucket_name_key,
        excluded_dates_key="excludedDates" if area_mode else None,
    )

    slot_info = {}
    n_slots = {}
    for b in bucket_names:
        n_slots[b] = len(calendar[b])
        for t, sl in enumerate(calendar[b]):
            slot_info[(b, t)] = sl

    def date_of(b, t):
        return slot_info[(b, t)]["date"]

    def ft_of(b, t):
        return slot_info[(b, t)]["from_time"]

    if not area_mode:
        for b in bucket_names:
            total_req = sum(v for (bucket, _), v in required.items() if bucket == b)
            total_avail = n_slots[b]
            # Extra capacity is allowed; only a shortage of slots is infeasible.
            if total_req > total_avail:
                return {
                    "status": "error",
                    "message": f"Section {b}: {total_req} required sessions exceed {total_avail} available slots",
                    "timetable": [],
                }

    def _is_faculty_unavailable(f, d, ft):
        fac_map = unavail.get(f, {})
        if d not in fac_map:
            return False
        return None in fac_map[d] or ft in fac_map[d]

    # Section-mode capacity check after H6.
    # A section slot is usable if at least one mapped course/faculty for that section
    # can be scheduled in that date+fromTime.
    if apply_unavail and not area_mode:
        courses_by_section = defaultdict(list)
        for (b, c), f in faculty_map.items():
            courses_by_section[b].append((c, f))
        messages = []
        for b in bucket_names:
            required_sessions = sum(
                req
                for (bucket, _course), req in required.items()
                if bucket == b
            )

            usable_slots = 0
            blocked_slots = []

            for t in range(n_slots[b]):
                d = date_of(b, t)
                ft = ft_of(b, t)

                has_available_faculty = any(
                    not _is_faculty_unavailable(f, d, ft)
                    for _c, f in courses_by_section[b]
                )

                if has_available_faculty:
                    usable_slots += 1
                else:
                    blocked_slots.append(slot_info[(b, t)])

            if usable_slots < required_sessions:
                slots = ", ".join(
                    f"{sl['date']} {sl['from_time']}-{sl['to_time']}"
                    for sl in blocked_slots
                )

                messages.append(
                        f"Section {b}: {required_sessions} sessions required, but only "
                        f"{usable_slots} usable slots remain after faculty unavailability. "
                        f"Fully blocked slots: {slots}"
                    )
    
        for (b, c), req in required.items():
            f = faculty_map[(b, c)]
            available_dates = {
                date_of(b, t)
                for t in range(n_slots[b])
                if not _is_faculty_unavailable(f, date_of(b, t), ft_of(b, t))
            }
            if len(available_dates) < req:
                messages.append(
                        f"{'Section' if not area_mode else 'Area'} {b}: Course {c}: Faculty {f}: {req} sessions required, but only "
                        f"{len(available_dates)} available teaching dates remain after faculty unavailability. "
                        "\nA course can be scheduled at most once per section per day."
                    )
        if messages:
            return {
                "status": "error",
                "constraint_type": "soft" if consec_enabled else "hard",
                "penalty": None,
                "timetable": [],
                "message": '\n'.join(messages),
            }

    def _pk(d):
        if period_unit == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    def _bk(d):
        if reset_boundary == "month":
            return d.year * 100 + d.month
        return 0

    def _is_next_period(cur_pk, next_pk):
        if period_unit == "weeks":
            cur_year, cur_week = cur_pk // 100, cur_pk % 100
            nxt_year, nxt_week = next_pk // 100, next_pk % 100
            try:
                cur_start = date.fromisocalendar(cur_year, cur_week, 1)
                nxt_start = date.fromisocalendar(nxt_year, nxt_week, 1)
            except ValueError:
                return False
            return nxt_start == cur_start + timedelta(days=7)
        return next_pk == cur_pk + 1

    def _bk_from_pk(pk):
        if reset_boundary != "month":
            return 0
        if period_unit == "weeks":
            year, week = pk // 100, pk % 100
            try:
                d = date.fromisocalendar(year, week, 1)
            except ValueError:
                return -1
            return d.year * 100 + d.month
        return _bk(date.fromordinal(pk))

    fac_date_slots = defaultdict(list)
    for (b, c), f in faculty_map.items():
        for t in range(n_slots[b]):
            fac_date_slots[(f, date_of(b, t))].append((b, c, t))

    time_slot_fac = defaultdict(lambda: defaultdict(list))
    for (b, c), f in faculty_map.items():
        for t in range(n_slots[b]):
            time_slot_fac[(date_of(b, t), ft_of(b, t))][f].append((b, c, t))

    date_slots = defaultdict(lambda: defaultdict(list))
    for b in bucket_names:
        for t in range(n_slots[b]):
            date_slots[b][date_of(b, t)].append(t)

    prob = pulp.LpProblem("Class_Timetable", pulp.LpMinimize)

    x = {
        (b, c, t): pulp.LpVariable(f"x_{b}_{c}_{t}", cat="Binary")
        for b in bucket_names
        for c in COURSES
        if (b, c) in valid_pairs
        for t in range(n_slots[b])
    }

    # Consecutive scope:
    # - sections mode: (section, course)
    # - areas mode: course across all areas
    consec_period_triplets = defaultdict(list)
    for (b, c, t) in x:
        scope = c if area_mode else (b, c)
        pk = _pk(date_of(b, t))
        consec_period_triplets[(scope, pk)].append((b, c, t))

    def _scope_label(scope):
        if area_mode:
            return str(scope)
        b, c = scope
        return f"{b}_{c}"

    y = {
        (scope, pk): pulp.LpVariable(f"y_{_scope_label(scope)}_{pk}", cat="Binary")
        for (scope, pk) in consec_period_triplets
    }

    penalty_windows = []
    p = {}

    if consec_enabled:
        window_size = max_consecutive + 1
        all_periods = defaultdict(set)
        for (scope, pk) in consec_period_triplets:
            all_periods[scope].add(pk)

        for scope, pset in all_periods.items():
            sorted_periods = sorted(pset)
            for i in range(len(sorted_periods) - window_size + 1):
                window = sorted_periods[i : i + window_size]
                valid = True

                for j in range(len(window) - 1):
                    cur = window[j]
                    nxt = window[j + 1]
                    if not _is_next_period(cur, nxt):
                        valid = False
                        break

                if valid and reset_boundary != "none":
                    bk0 = _bk_from_pk(window[0])
                    if any(_bk_from_pk(w) != bk0 for w in window):
                        valid = False

                if valid:
                    penalty_windows.append((scope, window))
                    key = (scope, window[0])
                    if key not in p:
                        p[key] = pulp.LpVariable(f"p_{_scope_label(scope)}_{window[0]}", cat="Binary")

    prob += (pulp.lpSum(p.values()) if p else 0), "obj"

    for (b, c), req in required.items():
        prob += pulp.lpSum(x[(b, c, t)] for t in range(n_slots[b])) == req

    if not area_mode:
        for b in bucket_names:
            valid_c = [c for c in COURSES if (b, c) in valid_pairs]
            for t in range(n_slots[b]):
                prob += pulp.lpSum(x[(b, c, t)] for c in valid_c) <= 1

    for (d, ft), fac_grp in time_slot_fac.items():
        for f, triplets in fac_grp.items():
            if len(triplets) > 1:
                prob += pulp.lpSum(x[tr] for tr in triplets if tr in x) <= 1

    for (f, d), triplets in fac_date_slots.items():
        ml = max_load.get(f, 2)
        if len(triplets) > ml:
            prob += pulp.lpSum(x[tr] for tr in triplets if tr in x) <= ml

    for b in bucket_names:
        for c in COURSES:
            if (b, c) not in valid_pairs:
                continue
            for d, day_slots in date_slots[b].items():
                if len(day_slots) > 1:
                    prob += pulp.lpSum(x[(b, c, t)] for t in day_slots if (b, c, t) in x) <= 1

    for course in courses_cfg:
        code = course["code"]
        limit = int(course.get("maxSessionsPerMonth", 0) or 0)
        if limit <= 0:
            continue
        month_slots = defaultdict(list)
        for (b, c, t) in x:
            if c != code:
                continue
            d = date_of(b, t)
            month_slots[(d.year, d.month)].append((b, c, t))
        for triplets in month_slots.values():
            prob += pulp.lpSum(x[tr] for tr in triplets) <= limit

    if apply_unavail:
        for b in bucket_names:
            for c in COURSES:
                if (b, c) not in valid_pairs:
                    continue
                f = faculty_map[(b, c)]
                for t in range(n_slots[b]):
                    d = date_of(b, t)
                    ft = ft_of(b, t)
                    if _is_faculty_unavailable(f, d, ft):
                        prob += x[(b, c, t)] == 0

    if apply_conflicts:
        for group in data.get("courseConflicts", []):
            group_courses = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))
            scope_buckets = list(group_sections) if group_sections else bucket_names

            dt_ft_triplets = defaultdict(list)
            for b in scope_buckets:
                for c in group_courses:
                    if (b, c) not in valid_pairs:
                        continue
                    for t in range(n_slots[b]):
                        dt_ft_triplets[(date_of(b, t), ft_of(b, t))].append((b, c, t))

            for triplets in dt_ft_triplets.values():
                valid_triplets = [tr for tr in triplets if tr in x]
                if len(valid_triplets) > 1:
                    prob += pulp.lpSum(x[tr] for tr in valid_triplets) <= 1

    for (scope, pk), triplets in consec_period_triplets.items():
        valid_triplets = [tr for tr in triplets if tr in x]
        if not valid_triplets:
            continue
        for tr in valid_triplets:
            prob += y[(scope, pk)] >= x[tr]
        prob += y[(scope, pk)] <= pulp.lpSum(x[tr] for tr in valid_triplets)

    for (scope, window) in penalty_windows:
        pk0 = window[0]
        y_vars = [y[(scope, pk)] for pk in window if (scope, pk) in y]
        if len(y_vars) == len(window):
            prob += p[(scope, pk0)] >= pulp.lpSum(y_vars) - max_consecutive

    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=120)
    prob.solve(solver)

    status_str = pulp.LpStatus[prob.status]
    if status_str == "Infeasible":
        return {
            "status": "Infeasible",
            "constraint_type": "soft" if consec_enabled else "hard",
            "penalty": None,
            "timetable": [],
            "message": "No feasible timetable found — even with soft constraints. \n Check your configuration (slots, required sessions, faculty availability, conflict groups).",
        }

    if status_str not in ("Optimal", "Feasible"):
        return {
            "status": "error",
            "constraint_type": "soft" if consec_enabled else "hard",
            "penalty": None,
            "timetable": [],
            "message": f"Solver: {status_str}",
        }

    timetable = []
    for (b, c, t), var in x.items():
        value = cast(Any, pulp.value(var))
        if int(value or 0) == 1:
            si = slot_info[(b, t)]
            f = faculty_map[(b, c)]
            cm = course_meta[c]
            timetable.append({
                "date": str(si["date"]),
                "day": si["weekday"],
                "fromTime": si["from_time"],
                "toTime": si["to_time"],
                "timeLabel": si["time_label"],
                "section": b,
                "courseCode": c,
                "courseTitle": cm.get("title", c),
                "courseShort": cm.get("shortTitle", c),
                "facultyShort": f,
                "faculty": faculty_meta.get(f, {}).get("fullName", f),
            })

    timetable.sort(key=lambda r: (r["section"], r["date"], r["fromTime"]))
    objective_value = cast(Any, pulp.value(prob.objective))
    penalty = int(objective_value or 0) if consec_enabled else 0

    return {
        "status": "Optimal" if penalty == 0 else "Feasible",
        "constraint_type": "soft" if consec_enabled else "hard",
        "penalty": penalty,
        "timetable": timetable,
        "message": "Schedule generated successfully.",
    }

def run_solver(data):
    """Solve with configured constraints. The consecutive rule is always soft (penalty-minimized)."""
    return _solve(data)


#  verifier 
def verify_timetable(data, timetable):
    if not timetable:
        return {"error": "Empty timetable"}

    df = pd.DataFrame(timetable)
    df["date"] = pd.to_datetime(df["date"])
    df["week"] = df["date"].dt.isocalendar().week.astype(int)
    df["dateStr"] = df["date"].dt.strftime("%Y-%m-%d")

    bucket_col = "section" if "section" in df.columns else ("areaShortName" if "areaShortName" in df.columns else None)
    if not bucket_col:
        return {"error": "Timetable is missing section/area identifiers"}

    mode = data.get("configMode", "sections")
    area_mode = mode == "areas"
    bucket_cfgs = data.get("areas", []) if area_mode else data.get("sections", [])
    bucket_name_key = "shortName" if area_mode else "name"
    bucket_names = [b[bucket_name_key] for b in bucket_cfgs]
    bucket_set = set(bucket_names)

    mappings_cfg = data["mappings"]
    courses_cfg = {c["code"]: c for c in data["courses"]}
    faculty_cfg = {f["shortName"]: f for f in data["faculty"]}

    required = {}
    faculty_map = {}
    if area_mode:
        course_to_faculty = {m["courseCode"]: m["facultyShortName"] for m in mappings_cfg}
        for course in data["courses"]:
            code = course["code"]
            area = course.get("areaShortName", "").strip()
            if area in bucket_set:
                required[(area, code)] = courses_cfg[code]["requiredSlots"]
                faculty_map[(area, code)] = course_to_faculty.get(code, "?")
    else:
        for m in mappings_cfg:
            required[(m["section"], m["courseCode"])] = courses_cfg[m["courseCode"]]["requiredSlots"]
            faculty_map[(m["section"], m["courseCode"])] = m["facultyShortName"]

    # verifier: build same structure (dateStr -> set(fromTime) with '' or None indicating whole-day)
    unavail = {}
    for f in data["faculty"]:
        short = f.get("shortName")
        m = {}
        for d in f.get("unavailableDates", []) or []:
            m.setdefault(d, set()).add(None)
        for s in f.get("unavailableSlots", []) or []:
            if isinstance(s, dict) and s.get("date"):
                dt = s.get("date")
                ft = s.get("fromTime", "")
                m.setdefault(dt, set()).add(ft)
        unavail[short] = m

    session_violations = []
    for (b, c), req in required.items():
        actual = len(df[(df[bucket_col] == b) & (df["courseCode"] == c)])
        if actual != req:
            session_violations.append({"section": b, "course": c, "required": req, "scheduled": actual})

    slot_assignment_violations = []
    if not area_mode:
        slot_groups = df.groupby([bucket_col, "dateStr", "fromTime", "toTime"])
        for (b, dt, ft, tt), grp in slot_groups:
            assigned = len(grp)
            if assigned > 1:
                slot_assignment_violations.append({
                    "section": b,
                    "date": dt,
                    "fromTime": ft,
                    "toTime": tt,
                    "assignedCourses": grp["courseCode"].tolist(),
                    "count": assigned,
                })

    df["faculty"] = df.apply(lambda r: faculty_map.get((r[bucket_col], r["courseCode"]), "?"), axis=1)
    load_rows = df.groupby(["faculty", "dateStr"]).size().reset_index(name="sessions")
    faculty_load_violations = []
    for _, row in load_rows.iterrows():
        f = row["faculty"]
        ml = int(faculty_cfg.get(f, {}).get("maxLoadPerDay", 2))
        sessions = int(row["sessions"])
        if sessions > ml:
            faculty_load_violations.append({
                "faculty": f,
                "date": row["dateStr"],
                "sessions": sessions,
                "maxAllowed": ml,
            })
    faculty_load_violations.sort(key=lambda x: (-x["sessions"], x["faculty"]))

    clone_violations = []
    for (dt, ft, fac), grp in df.groupby(["dateStr", "fromTime", "faculty"]):
        if len(grp) > 1:
            clone_violations.append({
                "faculty": fac,
                "date": dt,
                "time": ft,
                "sections": grp[bucket_col].tolist(),
            })

    spacing_violations = []
    for (b, dt, c), grp in df.groupby([bucket_col, "dateStr", "courseCode"]):
        if len(grp) > 1:
            spacing_violations.append({"section": b, "date": dt, "course": c, "count": len(grp)})

    monthly_violations = []
    for course in data["courses"]:
        code = course["code"]
        limit = int(course.get("maxSessionsPerMonth", 0) or 0)
        if limit <= 0:
            continue
        sub = df[df["courseCode"] == code].copy()
        if sub.empty:
            continue
        sub["monthKey"] = sub["date"].dt.strftime("%Y-%m")
        for month_key, grp in sub.groupby("monthKey"):
            if len(grp) > limit:
                monthly_violations.append({
                    "course": code,
                    "month": month_key,
                    "scheduled": len(grp),
                    "maxAllowed": limit,
                })

    _ccfg = data.get("constraintConfig", {})
    apply_unavail = _ccfg.get("facultyUnavailability", True)
    unavail_violations = []
    if apply_unavail:
        for _, row in df.iterrows():
            f = row["faculty"]
            dt = row["dateStr"]
            ft = row["fromTime"]
            fac_map = unavail.get(f, {})
            if dt in fac_map:
                if None in fac_map[dt] or ft in fac_map[dt]:
                    unavail_violations.append({
                        "faculty": f,
                        "date": dt,
                        "section": row[bucket_col],
                        "course": row["courseCode"],
                    })

    apply_conflicts_v = _ccfg.get("courseConflicts", True)
    conflict_violations = []
    if apply_conflicts_v:
        for idx, group in enumerate(data.get("courseConflicts", []), start=1):
            group_courses = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))
            scope_buckets = group_sections if group_sections else set(bucket_names)

            sub = df[(df["courseCode"].isin(group_courses)) & (df[bucket_col].isin(scope_buckets))].copy()
            if sub.empty:
                continue

            for (dt, ft), grp in sub.groupby(["dateStr", "fromTime"]):
                if len(grp) > 1:
                    conflict_violations.append({
                        "groupIndex": idx,
                        "date": dt,
                        "time": ft,
                        "courses": sorted(set(grp["courseCode"].tolist())),
                        "sections": sorted(set(grp[bucket_col].tolist())),
                        "count": len(grp),
                    })

    _crule = _ccfg.get("consecutiveRule", {})
    consec_enabled_v = _crule.get("enabled", True)
    max_consecutive_v = max(1, int(_crule.get("maxConsecutive", 2)))
    period_unit_v = _crule.get("periodUnit", "weeks")
    reset_boundary_v = _crule.get("resetBoundary", "month")

    def _pk_v(d):
        if period_unit_v == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    def _bk_v(d):
        if reset_boundary_v == "month":
            return d.year * 100 + d.month
        return 0

    def _is_next_period_v(cur_pk, next_pk):
        if period_unit_v == "weeks":
            cur_year, cur_week = cur_pk // 100, cur_pk % 100
            nxt_year, nxt_week = next_pk // 100, next_pk % 100
            try:
                cur_start = date.fromisocalendar(cur_year, cur_week, 1)
                nxt_start = date.fromisocalendar(nxt_year, nxt_week, 1)
            except ValueError:
                return False
            return nxt_start == cur_start + timedelta(days=7)
        return next_pk == cur_pk + 1

    def _bk_from_pk_v(pk):
        if reset_boundary_v != "month":
            return 0
        if period_unit_v == "weeks":
            year, week = pk // 100, pk % 100
            try:
                d = date.fromisocalendar(year, week, 1)
            except ValueError:
                return -1
            return d.year * 100 + d.month
        return _bk_v(date.fromordinal(pk))

    def _pk_label_v(pk):
        if period_unit_v == "weeks":
            year = pk // 100
            week = pk % 100
            return f"Wk {week}, {year}"
        from datetime import date as _d
        return str(_d.fromordinal(pk))

    consec_violations = []
    if consec_enabled_v:
        window_size_v = max_consecutive_v + 1

        if area_mode:
            consec_scopes = sorted({c for (_b, c) in required.keys()})
        else:
            consec_scopes = sorted(required.keys())

        for scope in consec_scopes:
            if area_mode:
                c = scope
                sub = df[df["courseCode"] == c].copy()
                b = None
            else:
                b, c = scope
                sub = df[(df[bucket_col] == b) & (df["courseCode"] == c)].copy()

            if sub.empty:
                continue

            sub["pk"] = sub["date"].apply(_pk_v)
            periods = sorted(sub["pk"].unique())

            for i in range(len(periods) - max_consecutive_v):
                window = periods[i : i + window_size_v]
                if len(window) < window_size_v:
                    continue

                if any(not _is_next_period_v(window[j], window[j + 1]) for j in range(len(window) - 1)):
                    continue

                if reset_boundary_v != "none":
                    bk0 = _bk_from_pk_v(window[0])
                    if any(_bk_from_pk_v(w) != bk0 for w in window):
                        continue

                row = {
                    "course": c,
                    "periodStart": _pk_label_v(window[0]),
                    "periodEnd": _pk_label_v(window[-1]),
                    "windowSize": window_size_v,
                }
                if not area_mode:
                    row["section"] = b
                consec_violations.append(row)

    monthly_violations.sort(key=lambda x: (x["course"], x["month"]))

    week_dist = {}
    for b in df[bucket_col].unique():
        sub = df.loc[df[bucket_col] == b].copy()
        iso_cal = sub["date"].dt.isocalendar()
        sub["weekKey"] = (iso_cal.year.astype(int) * 100 + iso_cal.week.astype(int)).astype(int)
        sub["weekLabel"] = iso_cal.year.astype(str) + "-W" + iso_cal.week.astype(int).astype(str).str.zfill(2)

        pivot = sub.groupby(["weekKey", "courseCode"]).size().unstack(fill_value=0)
        week_keys = [int(wk) for wk in pivot.index.tolist()]
        week_labels = [
            f"{wk // 100}-W{str(wk % 100).zfill(2)}"
            for wk in week_keys
        ]

        week_dist[b] = {
            "weeks": week_keys,
            "weekLabels": week_labels,
            "courses": pivot.columns.tolist(),
            "data": pivot.values.tolist(),
        }

    return {
        "sessionCount": session_violations,
        "slotAssignmentViolations": slot_assignment_violations,
        "facultyLoad": faculty_load_violations,
        "cloneViolations": clone_violations,
        "spacingViolations": spacing_violations,
        "monthlyLimitViolations": monthly_violations,
        "unavailViolations": unavail_violations,
        "conflictViolations": conflict_violations,
        "consecutiveViolations": consec_violations,
        "weekDistribution": week_dist,
        "totalPenalty": len(consec_violations),
        "allClear": (
            len(session_violations) == 0 and
            len(slot_assignment_violations) == 0 and
            len(faculty_load_violations) == 0 and
            len(clone_violations) == 0 and
            len(spacing_violations) == 0 and
            len(monthly_violations) == 0 and
            len(unavail_violations) == 0 and
            len(conflict_violations) == 0
        ),
    }
