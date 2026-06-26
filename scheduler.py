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
  unavail[f] = mapping of dates to unavailable time slots (set of from_time values); 
                None indicates full-day unavailability  [optional — H6]
  M          = max_consecutive (integer ≥ 1, from constraintConfig)
               A window of (M+1) consecutive same-boundary periods triggers a penalty.
  α          = spread_weight (float, from constraintConfig.spreadingRule.weight, default 0.1)
               Relative penalty weight for the spreading rule vs the consecutive rule.
  D          = total calendar days in [start_date, end_date] (inclusive)
  epoch[b,c,i] = the set of slot indices t for (b,c) whose date falls in epoch i,
               where epoch i covers the day-offset range [i·D/req, (i+1)·D/req)
               and i ∈ {0, …, req[b,c]-1}

DECISION VARIABLES:
  x[b,c,t]   ∈ {0,1}  — 1 if bucket b is taught course c at slot t 
                        (in Sections mode there is exactly one course per (b,t); 
                        in Areas mode multiple x[b,c,t]=1 for a single (b,t) are allowed unless other constraints forbid them)
  y[scope,pk]  ∈ {0,1}  — 1 if bucket b has ≥ 1 session of course c in period pk
                        auxiliary presence variable for a scope in period pk where scope is:
                            - Sections mode: scope = (b,c) (bucket-course pair)
                            - Areas mode: scope = c (course-level scope)
  p[scope,pk0] ∈ {0,1}  — 1 if the window [pk0, pk0+1, …, pk0+M] is a consecutive violation for scope (scope is defined save as y)  
                        (only created when consecutive rule enabled)
  e[b,c,i]   ∈ {0,1}  — 1 if at least one session of course c in bucket b falls in epoch i
                        (only created when spreadingRule enabled and req[b,c] ≥ 2)

OBJECTIVE:
  Consecutive rule DISABLED → Minimize 0                      (pure feasibility)
  Consecutive ONLY    → Minimize Σ_{scope,pk0} p[scope,pk0]
  Spreading ONLY      → Minimize α × Σ_{b,c,i} (1 − e[b,c,i])
  Both ENABLED        → Minimize Σ_{scope,pk0} p[scope,pk0]  +  α × Σ_{b,c,i} (1 − e[b,c,i])

  α is kept small (recommended 0.01 – 0.5) so spreading acts as a secondary preference; the consecutive rule remains dominant.

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
         [courses in the same group may not run at the same date+time 
            (for affected sections in Sections mode, across all areas in Areas mode)]

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

SOFT CONSTRAINT — Session Spreading Rule (when enabled):
  Epoch definition — for each (b,c) pair with req[b,c] ≥ 2:
    The date range [start_date, end_date] is divided into req[b,c] equal-length epochs.
    Epoch i contains all slots t of bucket b whose date satisfies:
      floor(day_offset(date[b,t]) × req[b,c] / D) = i
    where day_offset(d) = (d − start_date).days and i ∈ {0, …, req[b,c]−1}.

  Auxiliary constraints linking e ↔ x:
  (E1) e[b,c,i] ≥ x[b,c,t]          ∀ t ∈ epoch[b,c,i]
       [e is forced to 1 if any session is placed in epoch i]
  (E2) e[b,c,i] ≤ Σ_{t ∈ epoch[b,c,i]} x[b,c,t]    ∀ b, c, i
       [e is forced to 0 if no sessions exist in epoch i — prevents free reward]

  Penalty contribution:
  (S)  (1 − e[b,c,i])  — equals 1 when epoch i is empty (gap penalty), 0 otherwise.
       Summed across all (b,c,i) and scaled by α in the objective.
       Over-filled epochs (more than one session) do not incur any additional penalty.

  Interaction with the consecutive rule:
    The two soft terms are additive in the objective and independent in their constraints.
    In rare cases they may pull in opposite directions (spreading wants sessions in every period; 
    the consecutive rule penalises too many adjacent periods). 
    The weight α resolves this: a small α lets the consecutive rule dominate; a larger α
    prioritises uniform distribution.
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

        # Group slot defs by weekday index for O(1) per-day dispatch
        by_weekday: dict[int, list] = defaultdict(list)
        for slot in bucket["slots"]:
            by_weekday[WEEKDAY[slot["weekday"]]].append(
                (slot["fromTime"], slot["toTime"], float(slot["duration"]))
            )

        slots = []
        cur = start_date
        while cur <= end_date:
            if cur not in excluded_dates:
                wd = cur.weekday()
                for (ft, tt, dur) in by_weekday.get(wd, []):
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
    # config
    _ccfg = data.get("constraintConfig", {})
    _crule = _ccfg.get("consecutiveRule", {})
    _spread        = _ccfg.get("spreadingRule", {})
    spread_enabled = _spread.get("enabled", False)
    spread_weight  = float(_spread.get("weight", 0.1))
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
            required[key]    = int(course_meta[code]["requiredSlots"])
            faculty_map[key] = course_to_faculty[code]
    else:
        for m in mappings_cfg:
            bucket = m["section"]
            code   = m["courseCode"]
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
    max_load = {}
    for f in faculty_cfg:
        short = f["shortName"]
        m = defaultdict(set)
        # legacy full-day unavailable dates
        for d in f.get("unavailableDates", []):
            try:
                m[_parse_date(d)].add(None)
            except Exception:
                continue
        # slot-level unavailability entries: list of {date, fromTime, toTime}
        for s in f.get("unavailableSlots", []):
            try:
                if isinstance(s, dict) and s.get("date"):
                    m[_parse_date(s["date"])].add(s.get("fromTime", ""))
            except Exception:
                continue
        unavail[short] = m
        max_load[short] = int(f.get("maxLoadPerDay", 2))

    def _is_faculty_unavailable(f: str, d: date, ft: str) -> bool:
        fac_map = unavail.get(f, {})
        if d not in fac_map:
            return False
        return None in fac_map[d] or ft in fac_map[d]

    # Calendar → flat slot_info
    calendar = _generate_bucket_calendar(
        bucket_cfgs, start_date, end_date, bucket_name_key,
        excluded_dates_key="excludedDates" if area_mode else None,
    )

    slot_info = {}
    n_slots = {}
    for b in bucket_names:
        sls = calendar[b]
        n_slots[b] = len(sls)
        for t, sl in enumerate(sls):
            slot_info[(b, t)] = sl
    del calendar  # no longer needed; all data lives in slot_info

    # Precompute required sessions per bucket (avoids repeated O(|req|) sums)
    req_per_bucket: dict[str, int] = defaultdict(int)
    for (bucket, _c), v in required.items():
        req_per_bucket[bucket] += v

    # Capacity checks
    if not area_mode:
        courses_by_section: dict[str, list] = defaultdict(list)
        for (b, c), f in faculty_map.items():
            courses_by_section[b].append((c, f))

        cap_messages: list[str] = []

        for b in bucket_names:
            total_req = req_per_bucket[b]
            total_avail = n_slots[b]

            # Raw slot count check
            if total_req > total_avail:
                return {
                    "status": "error",
                    "message": f"Section {b}: {total_req} required sessions exceed {total_avail} available slots",
                    "timetable": [],
                }

            # Usable-slot check after faculty unavailability
            if apply_unavail:
                usable_slots = 0
                blocked_slots: list[dict] = []
                for t in range(n_slots[b]):
                    sl = slot_info[(b, t)]
                    d, ft = sl["date"], sl["from_time"]
                    if any(not _is_faculty_unavailable(f, d, ft) for _c, f in courses_by_section[b]):
                        usable_slots += 1
                    else:
                        blocked_slots.append(sl)

                if usable_slots < total_req:
                    slots_str = ", ".join(
                        f"{sl['date']} {sl['from_time']}-{sl['to_time']}"
                        for sl in blocked_slots
                    )
                    cap_messages.append(
                        f"Section {b}: {total_req} sessions required, but only "
                        f"{usable_slots} usable slots remain after faculty unavailability. "
                        f"Fully blocked slots: {slots_str}"
                    )

        # Per-(b,c) available-dates check
        if apply_unavail:
            for (b, c), req in required.items():
                f = faculty_map[(b, c)]
                available_dates = {
                    slot_info[(b, t)]["date"]
                    for t in range(n_slots[b])
                    if not _is_faculty_unavailable(
                        f, slot_info[(b, t)]["date"], slot_info[(b, t)]["from_time"]
                    )
                }
                if len(available_dates) < req:
                    cap_messages.append(
                        f"Section {b}: Course {c}: Faculty {f}: {req} sessions required, "
                        f"but only {len(available_dates)} available teaching dates remain "
                        "after faculty unavailability.\n"
                        "A course can be scheduled at most once per section per day."
                    )

        if cap_messages:
            return {
                "status": "error",
                "constraint_type": "soft" if consec_enabled or spread_enabled else "hard",
                "penalty": None,
                "timetable": [],
                "message": "\n".join(cap_messages),
            }

    # Period-key helpers
    def _pk(d: date) -> int:
        if period_unit == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    def _bk(d: date) -> int:
        if reset_boundary == "month":
            return d.year * 100 + d.month
        return 0

    def _is_next_period(cur_pk: int, next_pk: int) -> bool:
        if period_unit == "weeks":
            try:
                cur_start = date.fromisocalendar(cur_pk // 100, cur_pk % 100, 1)
                nxt_start = date.fromisocalendar(next_pk // 100, next_pk % 100, 1)
            except ValueError:
                return False
            return nxt_start == cur_start + timedelta(days=7)
        return next_pk == cur_pk + 1

    def _bk_from_pk(pk: int) -> int:
        if reset_boundary != "month":
            return 0
        if period_unit == "weeks":
            try:
                d = date.fromisocalendar(pk // 100, pk % 100, 1)
            except ValueError:
                return -1
            return d.year * 100 + d.month
        return _bk(date.fromordinal(pk))

    # Combined index-building pass
    # a seen-set deduplicates date_slots entries when multiple (b,c) pairs share the same bucket.
    fac_date_slots: dict[tuple, list] = defaultdict(list)
    time_slot_fac:  dict[tuple, dict] = defaultdict(lambda: defaultdict(list))
    date_slots:     dict[str,  dict]  = defaultdict(lambda: defaultdict(list))
    _bt_seen: set[tuple] = set()

    for (b, c), f in faculty_map.items():
        for t in range(n_slots[b]):
            sl     = slot_info[(b, t)]
            d, ft  = sl["date"], sl["from_time"]
            fac_date_slots[(f, d)].append((b, c, t))
            time_slot_fac[(d, ft)][f].append((b, c, t))
            if (b, t) not in _bt_seen:
                _bt_seen.add((b, t))
                date_slots[b][d].append(t)
    del _bt_seen

    # Pre-build unavailability exclusion set (H6 optimisation)
    excluded_vars: set[tuple] = set()
    if apply_unavail:
        for (b, c), f in faculty_map.items():
            fac_unavail = unavail.get(f, {})
            if not fac_unavail:
                continue
            for t in range(n_slots[b]):
                sl = slot_info[(b, t)]
                d, ft = sl["date"], sl["from_time"]
                if d in fac_unavail and (None in fac_unavail[d] or ft in fac_unavail[d]):
                    excluded_vars.add((b, c, t))

    # Precompute valid courses per bucket (reused by H2 and H5)
    valid_c_for_bucket: dict[str, list] = defaultdict(list)
    for (b, c) in valid_pairs:
        valid_c_for_bucket[b].append(c)

    # LP variables
    prob = pulp.LpProblem("Class_Timetable", pulp.LpMinimize)

    # Unavailable (b,c,t) triples are excluded at creation — no x==0 constraints needed.
    x: dict[tuple, pulp.LpVariable] = {
        (b, c, t): pulp.LpVariable(f"x_{b}_{c}_{t}", cat="Binary")
        for (b, c) in valid_pairs
        for t in range(n_slots[b])
        if (b, c, t) not in excluded_vars
    }
    del excluded_vars  # no longer needed

    # Consecutive-rule auxiliary: group (b,c,t) triples by (scope, period_key)
    consec_period_triplets: dict[tuple, list] = defaultdict(list)
    for (b, c, t) in x:
        scope = c if area_mode else (b, c)
        pk = _pk(slot_info[(b, t)]["date"])
        consec_period_triplets[(scope, pk)].append((b, c, t))

    def _scope_label(scope) -> str:
        if area_mode:
            return str(scope)
        b, c = scope
        return f"{b}_{c}"

    y: dict[tuple, pulp.LpVariable] = {
        (scope, pk): pulp.LpVariable(f"y_{_scope_label(scope)}_{pk}", cat="Binary")
        for (scope, pk) in consec_period_triplets
    }

    penalty_windows: list[tuple] = []
    p: dict[tuple, pulp.LpVariable] = {}

    if consec_enabled:
        window_size = max_consecutive + 1
        all_periods: dict[Any, set] = defaultdict(set)
        for (scope, pk) in consec_period_triplets:
            all_periods[scope].add(pk)

        for scope, pset in all_periods.items():
            sorted_periods = sorted(pset)
            for i in range(len(sorted_periods) - window_size + 1):
                window = sorted_periods[i : i + window_size]
                # Check consecutive adjacency
                valid = all(
                    _is_next_period(window[j], window[j + 1])
                    for j in range(len(window) - 1)
                )
                # Check same boundary key
                if valid and reset_boundary != "none":
                    bk0   = _bk_from_pk(window[0])
                    valid = all(_bk_from_pk(w) == bk0 for w in window)
                if valid:
                    penalty_windows.append((scope, window))
                    key = (scope, window[0])
                    if key not in p:
                        p[key] = pulp.LpVariable(f"p_{_scope_label(scope)}_{window[0]}", cat="Binary")

    e = {}   # e[(b, c, i)] = 1 if epoch i has ≥1 session of course c in bucket b

    if spread_enabled:
        total_days = (end_date - start_date).days + 1

        for (b, c), req in required.items():
            if req < 2:
                continue  # nothing to spread

            # --- static pre-computation: assign each slot to an epoch index ---
            epoch_slots: dict[int, list] = defaultdict(list)
            for t in range(n_slots[b]):
                if (b, c, t) not in x:
                    continue  # slot excluded (unavailable)
                day_offset = (slot_info[(b, t)]["date"] - start_date).days
                # epoch_index in [0, req-1]
                epoch_idx  = min(int(day_offset * req / total_days), req - 1)
                epoch_slots[epoch_idx].append(t)

            for i, slots_in_epoch in epoch_slots.items():
                if not slots_in_epoch:
                    continue

                e_var = pulp.LpVariable(f"e_{b}_{c}_{i}", cat="Binary")
                e[(b, c, i)] = e_var

                # upper bound: e can only be 1 if at least one session exists in epoch i
                prob += e_var <= pulp.lpSum(x[(b, c, t)] for t in slots_in_epoch)

                # lower bounds: force e to 1 if any session is placed in epoch i
                for t in slots_in_epoch:
                    prob += e_var >= x[(b, c, t)]
        
    # Objective
    # Consecutive penalty term
    consec_term = pulp.lpSum(p.values()) if p else 0

    # Spreading term: penalise empty epochs (1 - e[b,c,i] = 1 when epoch is empty)
    # α is small so spreading is a secondary preference; consecutive rule stays dominant
    spread_term = (
        pulp.lpSum(1 - e_var for e_var in e.values()) * spread_weight
        if spread_enabled and e else 0
    )

    prob += consec_term + spread_term, "obj"

    # H1: Session Fulfillment
    # Note: sum only over existing x vars (unavailable slots were excluded).
    for (b, c), req in required.items():
        prob += pulp.lpSum(x[(b, c, t)] for t in range(n_slots[b]) if (b, c, t) in x) == req

    # H2: At Most One Course per Slot (sections mode only)
    if not area_mode:
        for b in bucket_names:
            valid_c = valid_c_for_bucket[b]   # precomputed; no re-scan of COURSES
            if len(valid_c) <= 1:
                continue  # constraint trivially satisfied
            for t in range(n_slots[b]):
                active_c = [c for c in valid_c if (b, c, t) in x]
                if len(active_c) > 1:
                    prob += pulp.lpSum(x[(b, c, t)] for c in active_c) <= 1

    # H3: No Faculty Cloning
    for (d, ft), fac_grp in time_slot_fac.items():
        for f, triplets in fac_grp.items():
            active = [tr for tr in triplets if tr in x]
            if len(active) > 1:
                prob += pulp.lpSum(x[tr] for tr in active) <= 1

    # H4: Maximum Daily Workload
    for (f, d), triplets in fac_date_slots.items():
        ml     = max_load.get(f, 2)
        active = [tr for tr in triplets if tr in x]
        if len(active) > ml:
            prob += pulp.lpSum(x[tr] for tr in active) <= ml

    # H5: Daily Course Spacing
    for b in bucket_names:
        for c in valid_c_for_bucket[b]:   # precomputed; avoids valid_pairs lookup
            for d, day_slots in date_slots[b].items():
                active_t = [t for t in day_slots if (b, c, t) in x]
                if len(active_t) > 1:
                    prob += pulp.lpSum(x[(b, c, t)] for t in active_t) <= 1

    # Monthly session limit
    # ONE pass over all x keys to build the month→triplets map, then O(1) lookup.
    course_month_slots: dict[str, dict] = defaultdict(lambda: defaultdict(list))
    for (b, c, t) in x:
        d = slot_info[(b, t)]["date"]
        course_month_slots[c][(d.year, d.month)].append((b, c, t))

    for course in courses_cfg:
        code  = course["code"]
        limit = int(course.get("maxSessionsPerMonth", 0) or 0)
        if limit <= 0:
            continue
        for triplets in course_month_slots[code].values():
            prob += pulp.lpSum(x[tr] for tr in triplets) <= limit
    del course_month_slots   # free immediately after use

    # H6: Faculty Unavailability
    # Handled by excluding unavailable (b,c,t) from x at creation time above.
    # No explicit constraints needed here.

    # H7: Course Conflict Groups
    if apply_conflicts:
        for group in data.get("courseConflicts", []):
            group_courses  = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))
            scope_buckets  = list(group_sections) if group_sections else bucket_names

            dt_ft_triplets: dict[tuple, list] = defaultdict(list)
            for b in scope_buckets:
                for c in group_courses:
                    if (b, c) not in valid_pairs:
                        continue
                    for t in range(n_slots[b]):
                        if (b, c, t) in x:
                            sl = slot_info[(b, t)]
                            dt_ft_triplets[(sl["date"], sl["from_time"])].append((b, c, t))

            for triplets in dt_ft_triplets.values():
                if len(triplets) > 1:
                    prob += pulp.lpSum(x[tr] for tr in triplets) <= 1

    # Consecutive auxiliary constraints
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

    # Free LP-build temporaries before handing off to the solver
    # These structures are no longer needed once constraints are posted.
    del fac_date_slots, time_slot_fac, date_slots
    del consec_period_triplets, penalty_windows
    del e   # values already baked into prob constraints; dict not needed at runtime

    # Solve
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=100, threads=4)
    prob.solve(solver)

    status_str = pulp.LpStatus[prob.status]

    if status_str == "Infeasible":
        del prob, x, y, p
        return {
            "status": "Infeasible",
            "constraint_type": "soft" if consec_enabled or spread_enabled else "hard",
            "penalty": None,
            "timetable": [],
            "message": "No feasible timetable found — even with soft constraints. \n Check your configuration (slots, required sessions, faculty availability, conflict groups).",
        }

    if status_str not in ("Optimal", "Feasible"):
        del prob, x, y, p
        return {
            "status": "error",
            "constraint_type": "soft" if consec_enabled or spread_enabled else "hard",
            "penalty": None,
            "timetable": [],
            "message": f"Solver: {status_str}",
        }

    # Extract solution, then immediately free LP objects
    # Pulling just the keys with value==1 avoids keeping the full x dict alive
    # while building the timetable list.
    active_assignments: set[tuple] = {
        k for k, var in x.items() if int(pulp.value(var) or 0) == 1
    }
    penalty = round(float(pulp.value(prob.objective) or 0), 2) if consec_enabled or spread_enabled else 0
    del prob, x, y, p   # LP objects are no longer needed

    # Build timetable from extracted assignments
    timetable = []
    for (b, c, t) in active_assignments:
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
    del slot_info, active_assignments   # free remaining temporaries

    timetable.sort(key=lambda r: (r["section"], r["date"], r["fromTime"]))

    return {
        "status": "Optimal" if penalty == 0 else "Feasible",
        "constraint_type": "soft" if consec_enabled or spread_enabled else "hard",
        "penalty": penalty,
        "timetable": timetable,
        "message": "Schedule generated successfully.",
    }

def run_solver(data):
    """Solve with configured constraints. The consecutive rule is always soft (penalty-minimized)."""
    return _solve(data)


# verifier
def verify_timetable(data, timetable):
    """
    Verify a timetable against all configured constraints.
    """
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

    # Rebuild required / faculty_map
    required:    dict[tuple, int] = {}
    faculty_map: dict[tuple, str] = {}
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

    # Build unavailability lookup sets (O(1) per row instead of dict-of-dict)
    # Separate sets for full-day blocks and slot-level blocks.
    unavail_full_day: set[tuple] = set()   # (faculty, dateStr)
    unavail_slots:    set[tuple] = set()   # (faculty, dateStr, fromTime)
    for f in data["faculty"]:
        short = f.get("shortName")
        for d in f.get("unavailableDates", []) or []:
            unavail_full_day.add((short, d))
        for s in f.get("unavailableSlots", []) or []:
            if isinstance(s, dict) and s.get("date"):
                unavail_slots.add((short, s["date"], s.get("fromTime", "")))

    # Derive faculty column once (shared by load, clone, unavail checks)
    df["faculty"] = df.apply(
        lambda r: faculty_map.get((r[bucket_col], r["courseCode"]), "?"), axis=1
    )

    # Session count violations
    # Single groupby replaces N individual df-filter calls.
    actual_counts = df.groupby([bucket_col, "courseCode"]).size()
    session_violations = [
        {
            "section":   b,
            "course":    c,
            "required":  req,
            "scheduled": int(actual_counts.get((b, c), 0)),
        }
        for (b, c), req in required.items()
        if int(actual_counts.get((b, c), 0)) != req
    ]

    # Slot assignment violations (sections mode only)
    slot_assignment_violations = []
    if not area_mode:
        for (b, dt, ft, tt), grp in df.groupby([bucket_col, "dateStr", "fromTime", "toTime"]):
            if len(grp) > 1:
                slot_assignment_violations.append({
                    "section": b,
                    "date": dt,
                    "fromTime": ft,
                    "toTime": tt,
                    "assignedCourses": grp["courseCode"].tolist(),
                    "count": len(grp),
                })

    # Faculty load violations
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
    faculty_load_violations.sort(key=lambda r: (-r["sessions"], r["faculty"]))

    # Clone violations
    clone_violations = []
    for (dt, ft, fac), grp in df.groupby(["dateStr", "fromTime", "faculty"]):
        if len(grp) > 1:
            clone_violations.append({
                "faculty": fac,
                "date": dt,
                "time": ft,
                "sections": grp[bucket_col].tolist(),
            })

    # Spacing violations
    spacing_violations = []
    for (b, dt, c), grp in df.groupby([bucket_col, "dateStr", "courseCode"]):
        if len(grp) > 1:
            spacing_violations.append({"section": b, "date": dt, "course": c, "count": len(grp)})

    # Monthly limit violations
    df["_monthKey"] = df["date"].dt.strftime("%Y-%m")
    monthly_violations = []
    for course in data["courses"]:
        code = course["code"]
        limit = int(course.get("maxSessionsPerMonth", 0) or 0)
        if limit <= 0:
            continue
        sub = df[df["courseCode"] == code]
        if sub.empty:
            continue
        for month_key, grp in sub.groupby("_monthKey"):
            if len(grp) > limit:
                monthly_violations.append({
                    "course": code,
                    "month": month_key,
                    "scheduled": len(grp),
                    "maxAllowed": limit,
                })
    monthly_violations.sort(key=lambda r: (r["course"], r["month"]))
    df.drop(columns=["_monthKey"], inplace=True)

    # Faculty unavailability violations
    _ccfg = data.get("constraintConfig", {})
    apply_unavail = _ccfg.get("facultyUnavailability", True)
    unavail_violations = []
    if apply_unavail:
        # Build boolean mask via zip (avoids slow iterrows for the check)
        fac_s  = df["faculty"]
        date_s = df["dateStr"]
        ft_s   = df["fromTime"]
        mask = [
            (f, dt) in unavail_full_day or (f, dt, ft) in unavail_slots
            for f, dt, ft in zip(fac_s, date_s, ft_s)
        ]
        # Only iterate over the (typically small) set of actual violations
        for _, row in df[mask].iterrows():
            unavail_violations.append({
                "faculty": row["faculty"],
                "date":    row["dateStr"],
                "section": row[bucket_col],
                "course":  row["courseCode"],
            })

    # Conflict group violations
    apply_conflicts_v = _ccfg.get("courseConflicts", True)
    conflict_violations = []
    if apply_conflicts_v:
        for idx, group in enumerate(data.get("courseConflicts", []), start=1):
            group_courses = set(group.get("courses", []))
            group_sections = set(group.get("sections", []))
            scope_buckets = group_sections if group_sections else set(bucket_names)

            sub = df[
                df["courseCode"].isin(group_courses) & df[bucket_col].isin(scope_buckets)
            ]
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

    # Consecutive violations
    _crule = _ccfg.get("consecutiveRule", {})
    consec_enabled_v = _crule.get("enabled", True)
    max_consecutive_v = max(1, int(_crule.get("maxConsecutive", 2)))
    period_unit_v = _crule.get("periodUnit", "weeks")
    reset_boundary_v = _crule.get("resetBoundary", "month")

    def _pk_v(d: date) -> int:
        if period_unit_v == "weeks":
            iso = d.isocalendar()
            return iso.year * 100 + iso.week
        return d.toordinal()

    def _is_next_period_v(cur_pk: int, next_pk: int) -> bool:
        if period_unit_v == "weeks":
            try:
                cur_start = date.fromisocalendar(cur_pk // 100, cur_pk % 100, 1)
                nxt_start = date.fromisocalendar(next_pk // 100, next_pk % 100, 1)
            except ValueError:
                return False
            return nxt_start == cur_start + timedelta(days=7)
        return next_pk == cur_pk + 1

    def _bk_from_pk_v(pk: int) -> int:
        if reset_boundary_v != "month":
            return 0
        if period_unit_v == "weeks":
            try:
                d = date.fromisocalendar(pk // 100, pk % 100, 1)
            except ValueError:
                return -1
            return d.year * 100 + d.month
        d = date.fromordinal(pk)
        return d.year * 100 + d.month

    def _pk_label_v(pk: int) -> str:
        if period_unit_v == "weeks":
            return f"Wk {pk % 100}, {pk // 100}"
        return str(date.fromordinal(pk))

    consec_violations = []
    if consec_enabled_v:
        window_size_v = max_consecutive_v + 1
        consec_scopes = (
            sorted({c for (_b, c) in required.keys()}) if area_mode
            else sorted(required.keys())
        )

        for scope in consec_scopes:
            if area_mode:
                c = scope
                sub = df[df["courseCode"] == c]
            else:
                b, c = scope
                sub = df[(df[bucket_col] == b) & (df["courseCode"] == c)]

            if sub.empty:
                continue

            periods = sorted(sub["date"].apply(_pk_v).unique())

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

                entry: dict = {
                    "course": c,
                    "periodStart": _pk_label_v(window[0]),
                    "periodEnd": _pk_label_v(window[-1]),
                    "windowSize": window_size_v,
                }
                if not area_mode:
                    entry["section"] = b
                consec_violations.append(entry)

    # Week distribution
    # Compute iso-calendar columns ONCE on the full df; slice per-bucket for pivot.
    iso_cal          = df["date"].dt.isocalendar()
    df["_weekKey"]   = (iso_cal.year.astype(int) * 100 + iso_cal.week.astype(int)).astype(int)

    week_dist: dict[str, dict] = {}
    for b in df[bucket_col].unique():
        sub = df.loc[df[bucket_col] == b]
        pivot = sub.groupby(["_weekKey", "courseCode"]).size().unstack(fill_value=0)
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

    # Drop all temporary columns added to df
    df.drop(columns=["_weekKey"], inplace=True, errors="ignore")

    # Spreading violations
    _spread_v        = _ccfg.get("spreadingRule", {})
    spread_enabled_v = _spread_v.get("enabled", False)
    spread_weight  = float(_spread_v.get("weight", 0.1))
    
    spreading_violations = []

    if spread_enabled_v:
        start_date_v = _parse_date(data["startDate"])
        end_date_v   = _parse_date(data["endDate"])
        total_days_v = (end_date_v - start_date_v).days + 1

        # Precompute slot weekdays + excluded dates per bucket
        # mirrors the solver's slot_info / excluded_vars logic
        _WDAY_MAP = {
            "Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
            "Friday": 4, "Saturday": 5, "Sunday": 6,
        }
        bucket_slot_defs:  dict[str, list] = {}
        bucket_excl_dates: dict[str, set]  = {}

        if area_mode:
            for area_cfg in data.get("areas", []):
                aname = area_cfg.get("shortName", "")
                bucket_slot_defs[aname]  = [
                    (_WDAY_MAP[sl["weekday"]], sl["fromTime"])
                    for sl in area_cfg.get("slots", [])
                ]
                # excludedDates are stored as strings ("YYYY-MM-DD") — keep as-is
                bucket_excl_dates[aname] = set(area_cfg.get("excludedDates", []))
        else:
            for sec_cfg in data.get("sections", []):
                sname = sec_cfg.get("name", "")
                bucket_slot_defs[sname]  = [
                    (_WDAY_MAP[sl["weekday"]], sl["fromTime"])
                    for sl in sec_cfg.get("slots", [])
                ]
                bucket_excl_dates[sname] = set()   # sections have no excludedDates
        
        for (b, c), req in required.items():
            if req < 2:
                continue

            # Filter sessions for this (b, c) pair
            sub = df[(df[bucket_col] == b) & (df["courseCode"] == c)]
            if sub.empty:
                continue  # already caught by session_violations

            # Assign each actual session to its epoch index (same formula as solver)
            epoch_hits: dict[int, list[str]] = defaultdict(list)  # epoch_idx → [dateStr]
            for _, row in sub.iterrows():
                day_offset = (row["date"].date() - start_date_v).days
                epoch_idx  = min(int(day_offset * req / total_days_v), req - 1)
                epoch_hits[epoch_idx].append(row["dateStr"])

            # Determine which epoch indices have ≥1 schedulable slot for this (b, c) pair.
            # This exactly mirrors the solver: e[(b,c,i)] is only created when epoch_slots[i]
            # is non-empty, so only those epochs can contribute a penalty.
            available_epochs: set[int] = set()
            slot_defs_bc  = bucket_slot_defs.get(b, [])
            excl_dates_bc = bucket_excl_dates.get(b, set())
            f_v           = faculty_map.get((b, c), "?")

            cur = start_date_v
            while cur <= end_date_v:
                cur_str = str(cur)          # "YYYY-MM-DD" — matches excludedDates string format
                if cur_str not in excl_dates_bc:
                    wd = cur.weekday()
                    for (slot_wd, ft) in slot_defs_bc:
                        if slot_wd == wd:
                            # Also check faculty unavailability — solver excludes these from x
                            if (f_v, cur_str) not in unavail_full_day \
                            and (f_v, cur_str, ft) not in unavail_slots:
                                day_offset = (cur - start_date_v).days
                                epoch_idx  = min(int(day_offset * req / total_days_v), req - 1)
                                available_epochs.add(epoch_idx)
                cur += timedelta(days=1)
            
            # Compute human-readable date range for each epoch
            epoch_ranges: list[dict] = []
            for i in range(req):
                epoch_start = start_date_v + timedelta(days=int(i * total_days_v / req))
                epoch_end   = start_date_v + timedelta(days=int((i + 1) * total_days_v / req) - 1)
                epoch_end   = min(epoch_end, end_date_v)
                epoch_ranges.append({
                    "epochIndex":    i,
                    "epochStart":    str(epoch_start),
                    "epochEnd":      str(epoch_end),
                    "sessionDates":  epoch_hits.get(i, []),        # [] means empty epoch
                    "sessionCount":  len(epoch_hits.get(i, [])),
                    "isEmpty":       i not in epoch_hits and i in available_epochs,  # mirrors solver: only penalize if schedulable slots exist
                })

            empty_count = sum(1 for ep in epoch_ranges if ep["isEmpty"])
            if empty_count == 0:
                continue  # perfectly spread, no violation

            spreading_violations.append({
                "section":      b,
                "course":       c,
                "totalEpochs":  req,
                "emptyEpochs":  empty_count,
                "penalty":      round(empty_count * spread_weight, 2),      # mirrors solver: alpha point per empty epoch
                "epochs":       epoch_ranges,     # full breakdown for UI drill-down
            })
        
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
        "consecutiveViolationsPenalty": len(consec_violations),
        # "spreadingViolations": spreading_violations,
        "spreadingViolationsPenalty": round(sum(v["penalty"] for v in spreading_violations), 2),
        "weekDistribution": week_dist,
        "allClear": (
            len(session_violations) == 0 and
            len(slot_assignment_violations) == 0 and
            len(faculty_load_violations) == 0 and
            len(clone_violations) == 0 and
            len(spacing_violations) == 0 and
            len(monthly_violations) == 0 and
            len(unavail_violations) == 0 and
            len(conflict_violations) == 0 and
            len(consec_violations) == 0 and
            len(spreading_violations) == 0
        ),
    }
