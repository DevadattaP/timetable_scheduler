"""
scheduler.py — Class Timetable LP Solver (JSON in / JSON out)
Requires: pulp, pandas
=================================================================================
MATHEMATICAL FORMULATION SUMMARY
----------------------------------
 
SETS:
  S  = {A, B, C, D, E, F}           — Sections
  C  = {OR, BL, EE, IS, FM1, OB2}   — Courses
  T_s = {0, ..., 39}                 — Slot indices for section s (40 slots each)
  F  = set of faculty members
  W  = set of ISO week numbers in the quarter
  G  = set of course conflict groups  
  C_g = set of courses in conflict group g  
  S_g = set of sections to which conflict group g applies  
 
PARAMETERS:
  req[s,c]        = number of sessions section s must have for course c
  fac[s,c]        = faculty assigned to teach course c to section s
  date[s,t]       = calendar date of slot t for section s
  week[s,t]       = ISO week number of slot t for section s
  unavail[f]      = set of dates faculty f is unavailable
  overlap[t1,t2]  = 1 if slots t1 (for some A-E section) and t2 share the same
                    calendar date AND same time window (always true for same
                    slot index across A-E sections; never true between A-E and F)
 
DECISION VARIABLES:
  x[s,c,t] ∈ {0,1}  — 1 if section s is taught course c at slot t
  y[s,c,w] ∈ {0,1}  — 1 if section s has at least one session of course c in week w
                        (auxiliary variable, derived from x)
  p[s,c,w] ∈ {0,1}  — 1 if course c is taught to section s in BOTH week w and w+1
                        (penalty variable for soft constraint)
 
OBJECTIVE:
  VERSION 1 (Hard): Minimize 0  [feasibility problem — likely INFEASIBLE]
  VERSION 2 (Soft): Minimize Σ_{s,c,w} p[s,c,w]  [minimize consecutive-week count]
 
HARD CONSTRAINTS:
  (H1) Session Fulfillment:  Σ_t x[s,c,t] = req[s,c]              ∀ s,c
  (H2) One Course per Slot:  Σ_c x[s,c,t] = 1                     ∀ s,t
  (H3) No Faculty Cloning:   Σ_{(s,c): fac[s,c]=f} x[s,c,t] ≤ 1  ∀ f, t (A-E slots only)
  (H4) Max m Sessions/Day:   Σ_{(s,c,t): date[s,t]=d, fac[s,c]=f} x[s,c,t] ≤ m  ∀ f,d
  (H5) Course Spacing:       Σ_{t: date[s,t]=d} x[s,c,t] ≤ 1     ∀ s,c,d
  (H6) Unavailability:       x[s,c,t] = 0  if fac[s,c] unavailable on date[s,t]
  (H7) Course Conflicts:     Σ_{c∈g} Σ_{t: date[s,t]=d} x[s,c,t] ≤ 1  ∀ g,d   (for sections that group g applies to)
  (H8) Alternate Weekend:    y[s,c,w] + y[s,c,w+1] ≤ 1          ∀ s,c,w
 
SOFT CONSTRAINT LINEARIZATION (alternate weekend rule):
  (S1) y[s,c,w] ≥ x[s,c,t]           ∀ s,c,t where week[s,t]=w  (y=1 if any session)
  (S2) y[s,c,w] ≤ Σ_{t∈w} x[s,c,t]  (y=0 if no sessions in week)
  (S3) p[s,c,w] ≥ y[s,c,w] + y[s,c,w+1] - 1  ∀ s,c,w   (penalty fires if both weeks active)

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
def _solve(data, use_hard_weekend):
    """
    Build and solve the ILP.

    Returns a result dict:
      status          : "optimal" | "infeasible" | "error"
      constraint_type : "hard" | "soft"
      penalty         : int   (0 for hard)
      timetable       : list of session dicts
      message         : human-readable note
    """
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
    sc_week_slots = defaultdict(list)   # (s,c,w) -> [t,...]
    for s in SECTIONS:
        for c in COURSES:
            if (s, c) not in valid_sc:
                continue
            for t in range(n_slots[s]):
                w = week_of(s, t)
                sc_week_slots[(s, c, w)].append(t)

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
    
    # y[s,c,w] = 1 if section s has any session of course c in ISO week w
    y = {
        (s, c, w): pulp.LpVariable(f"y_{s}_{c}_{w}", cat="Binary")
        for (s, c, w) in sc_week_slots
    }
    
    # p[s,c,w] = penalty: course c taught to section s in both week w AND w+1
    # (only needed for soft version, but defined for hard version too for consistency)
    p = {}
    if not use_hard_weekend:
        p = {
            (s, c, w): pulp.LpVariable(f"p_{s}_{c}_{w}", cat="Binary")
            for (s, c, w) in sc_week_slots
            if (s, c, w + 1) in sc_week_slots
        }

    #  objective 
    prob += (0 if use_hard_weekend else pulp.lpSum(p.values())), "obj"

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

    # HARD CONSTRAINT H6: Faculty unavailability
    # x[s,c,t] = 0  if fac[s,c] is unavailable on date[s,t]
    for s in SECTIONS:
        for c in COURSES:
            if (s, c) not in valid_sc:
                continue
            f = faculty_map[(s, c)]
            for t in range(n_slots[s]):
                if date_of(s, t) in unavail.get(f, set()):
                    prob += x[(s, c, t)] == 0
    
    # H7: course conflict groups with section filtering (courses that cannot run simultaneously for certain sections) 
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
    # (S1) y[s,c,w] ≥ x[s,c,t]           ∀ t in week w  (force y=1 if any session)
    # (S2) y[s,c,w] ≤ Σ_{t∈w} x[s,c,t]  (force y=0 if no sessions in week)
    for (s, c, w), week_slots in sc_week_slots.items():
        valid_slots = [t for t in week_slots if (s, c, t) in x]
        if not valid_slots:
            continue
        # (S1): y ≥ each individual x in this week
        for t in valid_slots:
            prob += y[(s, c, w)] >= x[(s, c, t)]
        # (S2): upper-bound y so it can't be 1 if no sessions scheduled
        prob += y[(s, c, w)] <= pulp.lpSum(x[(s, c, t)] for t in valid_slots)

    #  alternate-weekend rule 
    if use_hard_weekend:
        # HARD VERSION: y[s,c,w] + y[s,c,w+1] ≤ 1   ∀ s,c, consecutive (w,w+1)
        # This is the constraint that is expected to cause INFEASIBILITY
        # because supply == demand leaves no room to avoid consecutive weeks.
        for (s, c, w) in list(y.keys()):
            if (s, c, w + 1) in y:
                prob += y[(s, c, w)] + y[(s, c, w + 1)] <= 1
    else:
        # SOFT VERSION: penalize consecutive weeks via penalty variable p
        # (S3) p[s,c,w] ≥ y[s,c,w] + y[s,c,w+1] - 1
        # When both y[s,c,w]=1 and y[s,c,w+1]=1, RHS = 1, so p is forced ≥ 1 (→ =1).
        # Otherwise RHS ≤ 0, so constraint is trivially satisfied (p ≥ 0 suffices).
        for (s, c, w) in p:
            prob += p[(s, c, w)] >= y[(s, c, w)] + y[(s, c, w + 1)] - 1

    #  solve 
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=120)
    prob.solve(solver)

    status_str = pulp.LpStatus[prob.status]
    if status_str not in ("Optimal", "Feasible"):
        return {
            "status": "infeasible",
            "constraint_type": "hard" if use_hard_weekend else "soft",
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
    penalty = int(pulp.value(prob.objective) or 0) if not use_hard_weekend else 0

    return {
        "status": "optimal",
        "constraint_type": "hard" if use_hard_weekend else "soft",
        "penalty": penalty,
        "timetable": timetable,
        "message": "Schedule generated successfully.",
    }

def run_solver(data):
    """Try hard constraint first; fall back to soft if infeasible."""
    result = _solve(data, use_hard_weekend=True)
    if result["status"] == "optimal":
        return result
    result = _solve(data, use_hard_weekend=False)
    return result


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
    session_check = []
    for (s, c), req in required.items():
        actual = len(df[(df["section"] == s) & (df["courseCode"] == c)])
        session_check.append({
            "section": s, "course": c,
            "required": req, "scheduled": actual,
            "ok": actual == req,
        })

    # 2. Faculty load per day
    df["faculty"] = df.apply(
        lambda r: faculty_map.get((r["section"], r["courseCode"]), "?"), axis=1
    )

    load_rows = (
        df.groupby(["faculty", "dateStr"]).size().reset_index(name="sessions")
    )

    load_check = []

    # Faculty who appear in timetable
    faculty_in_tt = set(load_rows["faculty"].unique())

    # Add rows for faculty who have lectures
    for _, row in load_rows.iterrows():
        f = row["faculty"]
        ml = int(faculty_cfg.get(f, {}).get("maxLoadPerDay", 2))

        load_check.append({
            "faculty": f,
            "date": row["dateStr"],
            "sessions": int(row["sessions"]),
            "maxAllowed": ml,
            "ok": int(row["sessions"]) <= ml,
        })

    # Add faculty with ZERO lectures
    for f in faculty_cfg.keys():
        if f not in faculty_in_tt:
            ml = int(faculty_cfg.get(f, {}).get("maxLoadPerDay", 2))
            load_check.append({
                "faculty": f,
                "date": "No lecture assigned",
                "sessions": 0,
                "maxAllowed": ml,
                "ok": True,
            })

    load_check.sort(key=lambda x: (-x["sessions"], x["faculty"]))

    # 3. No faculty cloning (same date + same fromTime + same faculty)
    clone_violations = []
    for (dt, ft, fac), grp in df.groupby(["dateStr", "fromTime", "faculty"]):
        if len(grp) > 1:
            clone_violations.append({
                "faculty": fac, "date": dt, "time": ft,
                "sections": grp["section"].tolist(),
            })

    # 4. Course spacing — no same course twice on same day for same section
    spacing_violations = []
    for (s, dt, c), grp in df.groupby(["section", "dateStr", "courseCode"]):
        if len(grp) > 1:
            spacing_violations.append({
                "section": s, "date": dt, "course": c, "count": len(grp),
            })

    # 5. Unavailability violations
    unavail_violations = []
    for _, row in df.iterrows():
        f = row["faculty"]
        if row["dateStr"] in unavail.get(f, set()):
            unavail_violations.append({
                "faculty": f, "date": row["dateStr"],
                "section": row["section"], "course": row["courseCode"],
            })

    # 6. Consecutive-week violations
    consec_violations = []
    for (s, c) in required:
        weeks = sorted(df[(df["section"] == s) & (df["courseCode"] == c)]["week"].unique())
        for i in range(len(weeks) - 1):
            if weeks[i + 1] == weeks[i] + 1:
                consec_violations.append({
                    "section": s, "course": c,
                    "week": int(weeks[i]), "weekNext": int(weeks[i + 1]),
                })

    # 7. Week-course distribution per section (for heatmap)
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
        "sessionCount":          session_check,
        "facultyLoad":           load_check,
        "cloneViolations":       clone_violations,
        "spacingViolations":     spacing_violations,
        "unavailViolations":     unavail_violations,
        "consecutiveViolations": consec_violations,
        "weekDistribution":      week_dist,
        "totalPenalty":          len(consec_violations),
        "allClear": (
            all(r["ok"] for r in session_check) and
            all(r["ok"] for r in load_check) and
            len(clone_violations) == 0 and
            len(spacing_violations) == 0 and
            len(unavail_violations) == 0
        ),
    }
