"""
scheduler.py — Class Timetable LP Solver (JSON in / JSON out)
Requires: pulp, pandas
=================================================================================
MATHEMATICAL FORMULATION SUMMARY
----------------------------------

SETS:
  S   = set of sections (configured by user, e.g. {A, B, C, D, E, F})
  C   = set of course codes
  T_s = {0, …, n_s-1}  — ordered slot indices for section s
  F   = set of faculty short names
  PK  = set of period keys uniquely identifying each scheduling period:
        period_unit = "weeks" → pk = ISO year-week integer:
                                pk = iso_year * 100 + iso_week
                                Example: 2026-W10 → 202610
        period_unit = "days"  → pk = date.toordinal()
  G   = set of course conflict groups               [optional — H7]
  C_g = set of course codes in conflict group g
  S_g = set of sections to which conflict group g applies

PARAMETERS:
  req[s,c]   = required number of sessions for (section s, course c)
  fac[s,c]   = faculty member assigned to teach course c to section s
  date[s,t]  = calendar date of slot t for section s
  pk[s,t]    = period key of slot t  (see PK definition above)
  bk[s,t]    = boundary key of slot t; controls where the consecutive counter resets:
                 reset_boundary = "month" → bk = date.year × 100 + date.month
                 reset_boundary = "none"  → bk = 0  (no reset, sequence is continuous)
  m_f        = maximum sessions faculty f may teach per calendar day
  unavail[f] = set of calendar dates on which faculty f is unavailable  [optional — H6]
  M          = max_consecutive (integer ≥ 1, from constraintConfig)
               A window of (M+1) consecutive same-boundary periods triggers a penalty.

DECISION VARIABLES:
  x[s,c,t]   ∈ {0,1}  — 1 if section s is taught course c at slot t
  y[s,c,pk]  ∈ {0,1}  — 1 if section s has ≥ 1 session of course c in period pk
                          (auxiliary variable derived from x)
  p[s,c,pk0] ∈ {0,1}  — 1 if the window [pk0, pk0+1, …, pk0+M] is a consecutive
                          violation for (s, c)  (only created when consecutive rule enabled)

OBJECTIVE:
  Consecutive rule DISABLED → Minimize 0                      (pure feasibility)
  Consecutive rule ENABLED  → Minimize Σ_{s,c,pk0} p[s,c,pk0] (minimize violations)

FIXED HARD CONSTRAINTS (always applied):
  (H1) Session Fulfillment:
         Σ_t x[s,c,t] = req[s,c]    ∀ s, c

  (H2) One Course per Slot (zero slack):
         Σ_c x[s,c,t] = 1   ∀ s, t

  (H3) No Faculty Cloning:
         Σ_{(s,c): fac[s,c]=f} x[s,c,t] ≤ 1     ∀ f, (date, fromTime)
         [at any given date + time window, a faculty member appears in at most one section]

  (H4) Maximum Daily Workload:
         Σ_{(s,c,t): date[s,t]=d, fac[s,c]=f} x[s,c,t] ≤ m_f    ∀ f, d

  (H5) Daily Course Spacing:
         Σ_{t: date[s,t]=d} x[s,c,t] ≤ 1    ∀ s, c, d

OPTIONAL HARD CONSTRAINTS (toggled via constraintConfig):
  (H6) Faculty Unavailability:
         x[s,c,t] = 0   if fac[s,c] ∈ unavail and date[s,t] ∈ unavail[fac[s,c]]

  (H7) Course Conflict Groups:
         Σ_{c ∈ C_g, s ∈ S_g, t: (date[s,t], ft[s,t]) = (d, ft)} x[s,c,t] ≤ 1
         ∀ g, (d, ft)
         [courses in the same group may not run at the same date+time for affected sections]

SOFT CONSTRAINT — Consecutive Sessions Rule (when enabled):
  Auxiliary constraints linking y ↔ x:
  (A1) y[s,c,pk] ≥ x[s,c,t]                      ∀ s,c,t  where pk[s,t] = pk
       [y is forced to 1 if any session exists in period pk]
  (A2) y[s,c,pk] ≤ Σ_{t: pk[s,t]=pk} x[s,c,t]   ∀ s, c, pk
       [y is forced to 0 if no sessions exist in period pk]

  Window eligibility — a window W = [pk0, pk0+1, …, pk0+M] is eligible for (s,c) iff:
    (i)  All M+1 period keys exist in sc_period_slots for (s,c), AND
    (ii) All M+1 period keys share the same boundary key bk  (when reset_boundary ≠ "none")
         [sequences do not carry over across month boundaries, etc.]

  Penalty activation:
  (P)  p[s,c,pk0] ≥ Σ_{pk ∈ W} y[s,c,pk] - M    ∀ eligible windows W
       When all M+1 y-values equal 1 → RHS = 1, so p is forced to 1 (violation counted).
       When fewer than M+1 y-values equal 1 → RHS ≤ 0, constraint is slack (p stays 0).
"""

import pulp
import pandas as pd
from datetime import datetime, timedelta
from collections import defaultdict


#  helpers 
def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def _generate_calendar(sections, start_date, end_date):
    """
    For each section, produce an ordered list of slot dicts covering every
    matching weekday between start_date and end_date.

    Each slot dict: {date, weekday, from_time, to_time, duration, time_label}
    """
    WEEKDAY = {
        "Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
        "Friday": 4, "Saturday": 5, "Sunday": 6,
    }
    calendar = {}
    for sec in sections:
        slot_defs = [
            (WEEKDAY[sd["weekday"]], sd["fromTime"], sd["toTime"], float(sd["duration"]))
            for sd in sec["slots"]
        ]
        slots = []
        cur = start_date
        while cur <= end_date:
            wd = cur.weekday()
            for (wd_num, ft, tt, dur) in slot_defs:
                if wd == wd_num:
                    slots.append({
                        "date":       cur,
                        "weekday":    cur.strftime("%A"),
                        "from_time":  ft,
                        "to_time":    tt,
                        "duration":   dur,
                        "time_label": f"{ft} – {tt}",
                    })
            cur += timedelta(days=1)
        slots.sort(key=lambda x: (x["date"], x["from_time"]))
        calendar[sec["name"]] = slots
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
    # --- Constraint configuration ---
    _ccfg   = data.get("constraintConfig", {})
    _crule  = _ccfg.get("consecutiveRule", {})
    apply_unavail     = _ccfg.get("facultyUnavailability", True)
    apply_conflicts   = _ccfg.get("courseConflicts", True)
    consec_enabled    = _crule.get("enabled", True)
    max_consecutive   = max(1, int(_crule.get("maxConsecutive", 2)))
    period_unit       = _crule.get("periodUnit", "weeks")   # "weeks" | "days"
    reset_boundary    = _crule.get("resetBoundary", "month") # "none" | "month"
    
    start_date = _parse_date(data["startDate"])
    end_date   = _parse_date(data["endDate"])

    sections_cfg = data["sections"]
    courses_cfg  = data["courses"]
    faculty_cfg  = data["faculty"]
    mappings_cfg = data["mappings"]

    SECTIONS = [s["name"] for s in sections_cfg]
    COURSES  = [c["code"] for c in courses_cfg]

    #  lookups 
    course_meta  = {c["code"]: c for c in courses_cfg}
    faculty_meta = {f["shortName"]: f for f in faculty_cfg}

    required    = {}   # (sec, course_code) -> int
    faculty_map = {}   # (sec, course_code) -> short_name
    for m in mappings_cfg:
        key = (m["section"], m["courseCode"])
        required[key]    = course_meta[m["courseCode"]]["requiredSlots"]
        faculty_map[key] = m["facultyShortName"]

    valid_sc = set(faculty_map.keys())

    unavail = {}   # short_name -> set of dates
    for f in faculty_cfg:
        unavail[f["shortName"]] = {_parse_date(d) for d in f.get("unavailableDates", [])}

    max_load = {f["shortName"]: int(f.get("maxLoadPerDay", 2)) for f in faculty_cfg}

    #  calendar 
    calendar = _generate_calendar(sections_cfg, start_date, end_date)

    slot_info = {}
    n_slots   = {}
    for s in SECTIONS:
        n_slots[s] = len(calendar[s])
        for t, sl in enumerate(calendar[s]):
            slot_info[(s, t)] = sl

    def date_of(s, t): return slot_info[(s, t)]["date"]
    def week_of(s, t): return slot_info[(s, t)]["date"].isocalendar()[1]
    def ft_of(s, t):   return slot_info[(s, t)]["from_time"]

    #  validation 
    errors = []
    for s in SECTIONS:
        total_req   = sum(v for (sec, _), v in required.items() if sec == s)
        total_avail = n_slots[s]
        if total_req != total_avail:
            errors.append(
                f"Section {s}: {total_req} required sessions ≠ {total_avail} available slots"
            )
    if errors:
        return {"status": "error", "message": "; ".join(errors), "timetable": []}

    #  index structures 
    # Period key: unique integer per period (week-epoch or day-ordinal)
    def _pk(d):
        if period_unit == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    # Boundary key: group that resets the consecutive counter
    def _bk(d):
        if reset_boundary == "month": return d.year * 100 + d.month
        return 0  # no reset

    # Human-readable label for a period key (used in verify)
    def _pk_label(pk):
        if period_unit == "weeks":
            year = pk // 100
            week = pk % 100
            return f"Wk {week}, {year}"
        else:
            from datetime import date as _date
            return str(_date.fromordinal(pk))

    sc_period_slots = defaultdict(list)  # (s,c,pk) -> [t,...]
    period_boundary = {}                 # (s,pk) -> boundary key

    for s in SECTIONS:
        for c in COURSES:
            if (s, c) not in valid_sc:
                continue
            for t in range(n_slots[s]):
                pk = _pk(date_of(s, t))
                sc_period_slots[(s, c, pk)].append(t)
                period_boundary.setdefault((s, pk), _bk(date_of(s, t)))

    fac_date_slots = defaultdict(list)  # (fac, date) -> [(s,c,t), ...]
    for (s, c), f in faculty_map.items():
        for t in range(n_slots[s]):
            fac_date_slots[(f, date_of(s, t))].append((s, c, t))

    # no-cloning: group by (date, from_time, faculty)
    time_slot_fac = defaultdict(lambda: defaultdict(list))
    for (s, c), f in faculty_map.items():
        for t in range(n_slots[s]):
            time_slot_fac[(date_of(s, t), ft_of(s, t))][f].append((s, c, t))

    # date → slots per section
    date_slots = defaultdict(lambda: defaultdict(list))  # s -> date -> [t,...]
    for s in SECTIONS:
        for t in range(n_slots[s]):
            date_slots[s][date_of(s, t)].append(t)

    #  decision variables 
    prob = pulp.LpProblem("Class_Timetable", pulp.LpMinimize)
    
    # x[s,c,t] = 1 if section s is taught course c at slot t
    x = {
        (s, c, t): pulp.LpVariable(f"x_{s}_{c}_{t}", cat="Binary")
        for s in SECTIONS for c in COURSES
        if (s, c) in valid_sc
        for t in range(n_slots[s])
    }
    
    # y[(s,c,pk)] = 1 if section s has ≥1 session of course c in period pk
    y = {
        (s, c, pk): pulp.LpVariable(f"y_{s}_{c}_{pk}", cat="Binary")
        for (s, c, pk) in sc_period_slots
    }

    # Build penalty windows: each window is (max_consecutive+1) consecutive periods
    # within the same boundary group. A penalty variable fires if ALL periods in
    # the window have at least one session.
    penalty_windows = []  # list of (s, c, [pk0, pk1, ..., pk_M])
    p = {}

    if consec_enabled:
        window_size = max_consecutive + 1
        all_sc_periods = defaultdict(set)
        for (s, c, pk) in sc_period_slots:
            all_sc_periods[(s, c)].add(pk)

        for (s, c), pset in all_sc_periods.items():

            sorted_periods = sorted(pset)

            for i in range(len(sorted_periods) - window_size + 1):

                window = sorted_periods[i : i + window_size]

                valid = True

                # check consecutiveness
                for j in range(len(window) - 1):

                    cur = window[j]
                    nxt = window[j + 1]

                    if period_unit == "weeks":
                        cur_year = cur // 100
                        cur_week = cur % 100

                        nxt_year = nxt // 100
                        nxt_week = nxt % 100

                        # expected next ISO week
                        expected = cur_week + 1

                        if nxt_year == cur_year:
                            if nxt_week != expected:
                                valid = False
                                break

                        elif nxt_year == cur_year + 1:
                            # allow year rollover
                            if not (cur_week >= 52 and nxt_week == 1):
                                valid = False
                                break
                        else:
                            valid = False
                            break

                    else:
                        if nxt != cur + 1:
                            valid = False
                            break

                # same boundary check
                if valid and reset_boundary != "none":
                    bk0 = period_boundary.get((s, window[0]), 0)

                    if any(period_boundary.get((s, w), 0) != bk0 for w in window):
                        valid = False

                if valid:
                    penalty_windows.append((s, c, window))

                    key = (s, c, window[0])

                    if key not in p:
                        p[key] = pulp.LpVariable(
                            f"p_{s}_{c}_{window[0]}",
                            cat="Binary"
                        )

    #  objective 
    prob += (pulp.lpSum(p.values()) if p else 0), "obj"

    # HARD CONSTRAINT H1: Exact session fulfillment
    # Σ_t x[s,c,t] = req[s,c]   ∀ s,c
    for (s, c), req in required.items():
        prob += pulp.lpSum(x[(s, c, t)] for t in range(n_slots[s])) == req

    # HARD CONSTRAINT H2: Exactly one course per slot (zero slack)
    # Σ_c x[s,c,t] = 1   ∀ s,t
    for s in SECTIONS:
        valid_c = [c for c in COURSES if (s, c) in valid_sc]
        for t in range(n_slots[s]):
            prob += pulp.lpSum(x[(s, c, t)] for c in valid_c) == 1

    # HARD CONSTRAINT H3: No faculty cloning across A-E sections
    # At any slot t, a professor can appear in at most ONE section from A-E.
    # (A-E sections share the same time windows; F is in different time windows.)
    # Σ_{(s,c): fac[s,c]=f, s∈A-E} x[s,c,t] ≤ 1   ∀ f,t
    for (d, ft), fac_grp in time_slot_fac.items():
        for f, triplets in fac_grp.items():
            if len(triplets) > 1:
                prob += pulp.lpSum(
                    x[(s, c, t)] for (s, c, t) in triplets if (s, c, t) in x
                ) <= 1

    # HARD CONSTRAINT H4: Max sessions per faculty per calendar day
    # Σ_{(s,c,t): date[s,t]=d, fac[s,c]=f} x[s,c,t] ≤ max_load   ∀ f,d
    # (This is the binding constraint that links A-E and Section F schedules.)
    for (f, d), triplets in fac_date_slots.items():
        ml = max_load.get(f, 2)
        if len(triplets) > ml:
            prob += pulp.lpSum(
                x[(s, c, t)] for (s, c, t) in triplets if (s, c, t) in x
            ) <= ml

    # HARD CONSTRAINT H5: No same course twice in one day for a section
    # Σ_{t: date[s,t]=d} x[s,c,t] ≤ 1   ∀ s,c,d
    for s in SECTIONS:
        for c in COURSES:
            if (s, c) not in valid_sc:
                continue
            for d, day_slots in date_slots[s].items():
                if len(day_slots) > 1:
                    prob += pulp.lpSum(
                        x[(s, c, t)] for t in day_slots if (s, c, t) in x
                    ) <= 1

    # HARD CONSTRAINT H6: Faculty unavailability (optional)
    # x[s,c,t] = 0  if fac[s,c] is unavailable on date[s,t]
    if apply_unavail:
        for s in SECTIONS:
            for c in COURSES:
                if (s, c) not in valid_sc:
                    continue
                f = faculty_map[(s, c)]
                for t in range(n_slots[s]):
                    if date_of(s, t) in unavail.get(f, set()):
                        prob += x[(s, c, t)] == 0
    
    # H7: course conflict groups with section filtering (courses that cannot run simultaneously for certain sections) (optional)
    if apply_conflicts:
        for group in data.get("courseConflicts", []):
            group_courses = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))

            dt_ft_triplets = defaultdict(list)

            for s in SECTIONS:
                if s not in group_sections:
                    continue

                for c in group_courses:
                    if (s, c) not in valid_sc:
                        continue

                    for t in range(n_slots[s]):
                        dt_ft_triplets[(date_of(s, t), ft_of(s, t))].append((s, c, t))

            # Σ_{c∈g} Σ_{t: date[s,t]=d} x[s,c,t] ≤ 1  ∀ g,d   (for sections that group g applies to)
            for triplets in dt_ft_triplets.values():
                valid_triplets = [tr for tr in triplets if tr in x]
                if len(valid_triplets) > 1:
                    prob += pulp.lpSum(x[tr] for tr in valid_triplets) <= 1

    # AUXILIARY: Link y[s,c,w] to x[s,c,t]
    for (s, c, pk), period_slots_list in sc_period_slots.items():
        valid_slots = [t for t in period_slots_list if (s, c, t) in x]
        if not valid_slots:
            continue
        for t in valid_slots:
            prob += y[(s, c, pk)] >= x[(s, c, t)]
        prob += y[(s, c, pk)] <= pulp.lpSum(x[(s, c, t)] for t in valid_slots)

    # SOFT CONSECUTIVE RULE: p[(s,c,pk0)] fires when all periods in window have sessions
    # p >= sum(y[window]) - max_consecutive  (fires when sum = max_consecutive+1 = all 1s)
    for (s, c, window) in penalty_windows:
        pk0 = window[0]
        y_vars = [y[(s, c, pk)] for pk in window if (s, c, pk) in y]
        if len(y_vars) == len(window):
            prob += p[(s, c, pk0)] >= pulp.lpSum(y_vars) - max_consecutive

    #  solve 
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=120)
    prob.solve(solver)

    status_str = pulp.LpStatus[prob.status]
    if status_str not in ("Optimal", "Feasible", "Infeasible"):
        return {
            "status": "infeasible",
            "constraint_type": "soft" if consec_enabled else "hard",
            "penalty": None,
            "timetable": [],
            "message": f"Solver: {status_str}",
        }

    #  extract timetable 
    timetable = []
    for (s, c, t), var in x.items():
        if round(pulp.value(var) or 0) == 1:
            si = slot_info[(s, t)]
            f  = faculty_map[(s, c)]
            cm = course_meta[c]
            timetable.append({
                "date":        str(si["date"]),
                "day":         si["weekday"],
                "fromTime":    si["from_time"],
                "toTime":      si["to_time"],
                "timeLabel":   si["time_label"],
                "section":     s,
                "courseCode":  c,
                "courseTitle": cm.get("title", c),
                "courseShort": cm.get("shortTitle", c),
                "facultyShort": f,
                "faculty":     faculty_meta.get(f, {}).get("fullName", f),
            })

    timetable.sort(key=lambda r: (r["section"], r["date"], r["fromTime"]))
    penalty = int(pulp.value(prob.objective) or 0) if consec_enabled else 0

    return {
        "status": "optimal",
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
    df["date"]    = pd.to_datetime(df["date"])
    df["week"]    = df["date"].dt.isocalendar().week.astype(int)
    df["dateStr"] = df["date"].dt.strftime("%Y-%m-%d")

    mappings_cfg = data["mappings"]
    courses_cfg  = {c["code"]: c for c in data["courses"]}
    faculty_cfg  = {f["shortName"]: f for f in data["faculty"]}

    required    = {(m["section"], m["courseCode"]): courses_cfg[m["courseCode"]]["requiredSlots"]
                   for m in mappings_cfg}
    faculty_map = {(m["section"], m["courseCode"]): m["facultyShortName"]
                   for m in mappings_cfg}
    unavail     = {f["shortName"]: set(f.get("unavailableDates", []))
                   for f in data["faculty"]}

    # 1. Session counts
    session_violations = []
    for (s, c), req in required.items():
        actual = len(df[(df["section"] == s) & (df["courseCode"] == c)])
        if actual != req:
            session_violations.append({"section": s, "course": c, "required": req, "scheduled": actual,})

    # 2. One course per slot verification
    slot_assignment_violations = []
    slot_groups = df.groupby(["section", "dateStr", "fromTime", "toTime"])
    for (s, dt, ft, tt), grp in slot_groups:
        assigned = len(grp)
        if assigned != 1:
            slot_assignment_violations.append({
                "section": s,
                "date": dt,
                "fromTime": ft,
                "toTime": tt,
                "assignedCourses": grp["courseCode"].tolist(),
                "count": assigned,
            })
    
    # 3. Faculty load per day
    df["faculty"] = df.apply(lambda r: faculty_map.get((r["section"], r["courseCode"]), "?"), axis=1)
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

    # 4. No faculty cloning (same date + same fromTime + same faculty)
    clone_violations = []
    for (dt, ft, fac), grp in df.groupby(["dateStr", "fromTime", "faculty"]):
        if len(grp) > 1:
            clone_violations.append({
                "faculty": fac, "date": dt, "time": ft,
                "sections": grp["section"].tolist(),
            })

    # 5. Course spacing — no same course twice on same day for same section
    spacing_violations = []
    for (s, dt, c), grp in df.groupby(["section", "dateStr", "courseCode"]):
        if len(grp) > 1:
            spacing_violations.append({
                "section": s, "date": dt, "course": c, "count": len(grp),
            })

    # 6. Unavailability violations
    _ccfg  = data.get("constraintConfig", {})
    apply_unavail     = _ccfg.get("facultyUnavailability", True)
    unavail_violations = []
    if apply_unavail:
        for _, row in df.iterrows():
            f = row["faculty"]
            if row["dateStr"] in unavail.get(f, set()):
                unavail_violations.append({
                    "faculty": f, "date": row["dateStr"],
                    "section": row["section"], "course": row["courseCode"],
                })

    # 7. Course conflict group violations
    apply_conflicts_v = _ccfg.get("courseConflicts", True)

    conflict_violations = []

    if apply_conflicts_v:

        for idx, group in enumerate(data.get("courseConflicts", []), start=1):

            group_courses = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))

            sub = df[
                (df["courseCode"].isin(group_courses)) &
                (df["section"].isin(group_sections))
            ].copy()

            if sub.empty:
                continue

            grouped = sub.groupby(["dateStr", "fromTime"])

            for (dt, ft), grp in grouped:

                if len(grp) <= 1:
                    continue

                # if more than one conflicting course runs simultaneously
                courses_present = grp["courseCode"].tolist()
                sections_present = grp["section"].tolist()

                # distinct course-section combinations
                if len(grp) > 1:

                    conflict_violations.append({
                        "groupIndex": idx,
                        "date": dt,
                        "time": ft,
                        "courses": sorted(set(courses_present)),
                        "sections": sorted(set(sections_present)),
                        "count": len(grp),
                    })
                    
    # 8. Consecutive violations (respects configured rule)
    _crule = _ccfg.get("consecutiveRule", {})
    consec_enabled_v  = _crule.get("enabled", True)
    max_consecutive_v = max(1, int(_crule.get("maxConsecutive", 2)))
    period_unit_v     = _crule.get("periodUnit", "weeks")
    reset_boundary_v  = _crule.get("resetBoundary", "month")

    def _pk_v(d):
        if period_unit_v == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    def _bk_v(d):
        if reset_boundary_v == "month": return d.year * 100 + d.month
        return 0

    def _pk_label_v(pk):
        if period_unit_v == "weeks":
            year = pk // 100
            week = pk % 100
            return f"Wk {week}, {year}"
        else:
            from datetime import date as _d
            return str(_d.fromordinal(pk))

    consec_violations = []
    if consec_enabled_v:
        window_size_v = max_consecutive_v + 1
        for (s, c) in required:
            sub = df[(df["section"] == s) & (df["courseCode"] == c)].copy()
            sub["pk"] = sub["date"].apply(_pk_v)
            sub["bk"] = sub["date"].apply(_bk_v)
            pk_to_bk = sub.groupby("pk")["bk"].first().to_dict()
            periods = sorted(sub["pk"].unique())

            for i in range(len(periods) - max_consecutive_v):
                window = periods[i : i + window_size_v]
                if len(window) < window_size_v:
                    continue
                
                # All consecutive?
                valid_window = True
                for j in range(len(window) - 1):

                    cur = window[j]
                    nxt = window[j + 1]

                    if period_unit_v == "weeks":

                        cur_year = cur // 100
                        cur_week = cur % 100

                        nxt_year = nxt // 100
                        nxt_week = nxt % 100

                        if nxt_year == cur_year:
                            if nxt_week != cur_week + 1:
                                valid_window = False
                                break

                        elif nxt_year == cur_year + 1:
                            if not (cur_week >= 52 and nxt_week == 1):
                                valid_window = False
                                break

                        else:
                            valid_window = False
                            break

                    else:
                        if nxt != cur + 1:
                            valid_window = False
                            break

                if not valid_window:
                    continue
                
                # Same boundary group?
                if reset_boundary_v != 'none':
                    bk0 = pk_to_bk.get(window[0], 0)
                    if any(pk_to_bk.get(w, 0) != bk0 for w in window):
                        continue
                consec_violations.append({
                    "section":     s,
                    "course":      c,
                    "periodStart": _pk_label_v(window[0]),
                    "periodEnd":   _pk_label_v(window[-1]),
                    "windowSize":  window_size_v,
                })

    # 9. Week-course distribution per section (for heatmap)
    week_dist = {}
    for s in df["section"].unique():
        sub = df[df["section"] == s]
        pivot = (
            sub.groupby(["week", "courseCode"]).size()
               .unstack(fill_value=0)
        )
        week_dist[s] = {
            "weeks":   [int(w) for w in pivot.index.tolist()],
            "courses": pivot.columns.tolist(),
            "data":    pivot.values.tolist(),
        }

    return {
        "sessionCount": session_violations,
        "slotAssignmentViolations": slot_assignment_violations,
        "facultyLoad": faculty_load_violations,
        "cloneViolations": clone_violations,
        "spacingViolations": spacing_violations,
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
            len(unavail_violations) == 0 and
            len(conflict_violations) == 0
        ),
    }
