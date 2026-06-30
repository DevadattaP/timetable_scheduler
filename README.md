# ⏳ Timetable Generator using Linear Programming

Scheduling executive education is highly constrained. Professionals in the program have limited availability, meaning classes are restricted to weekends and specific evenings. Because several sections take the same courses taught by the same faculty members, the administration must carefully balance faculty workloads, avoid timing conflicts, and ensure a pedagogically sound distribution of classes — for example, preventing students from being taught the same subject in too many consecutive weeks without a break.

As a Business Analyst, we formulate this as a mathematical optimization problem and develop an automated scheduling model that generates a feasible and optimal timetable.

## Constraints

### Fixed Hard Constraints (always enforced)

1. **Required Fulfillment:** Every section must complete the required number of sessions for each of their courses. If total supply (available slots) exceeds total demand (required sessions), the extra slots may remain unused.

2. **At Most One Course per Slot:** Each available time slot for a section is occupied by at most one course, so unused slots are allowed when capacity exceeds demand.

3. **No Faculty Cloning:** A faculty member cannot teach two different sections at the exact same date and time.

4. **Maximum Daily Workload:** A faculty member can teach a maximum of *N* sessions per calendar day across all sections combined (configurable per faculty member; default is 2).

5. **Course Spacing (Daily):** A specific section cannot be taught the same course more than once in a single day.

### Optional Hard Constraints (can be toggled in the Constraints tab)

1. **Faculty Unavailability:** A faculty member cannot be scheduled on any timeslot listed in their unavailability log.

2. **Course Conflict Groups:** Courses assigned to the same conflict group cannot be scheduled at the same date and time, even across different sections. Conflict groups and the sections they apply to are configurable.

### Soft Constraint / Objective Function (minimized, not strictly enforced)

1. **Consecutive Sessions Rule:** For pedagogical reasons, students need time to digest course material between sessions of the same subject. The rule limits how many consecutive scheduling periods (weeks or days) the same course may be taught to the same section within a given boundary (e.g. within the same calendar month).

   - **Configurable parameters** (set in the Constraints tab):
     - *Max Consecutive* — the maximum number of consecutive periods allowed before a penalty is incurred (e.g. 2 weeks).
     - *Period Unit* — the unit of a "period": weekly or daily.
     - *Reset Boundary* — whether the consecutive counter resets at a calendar boundary such as a month (e.g. two consecutive weeks at the end of January and the start of February are **not** counted as consecutive when the boundary is set to "month").

   - **Why soft?** Due to the zero-slack condition and faculty unavailability, a schedule that perfectly avoids all consecutive-period repetition is often mathematically infeasible. The constraint is therefore modelled as a penalty: minimize the total number of windows in which the same course appears in more than the allowed number of consecutive periods for the same section.

2. **Spreading Sessions Rule:** For pedagogical reasons, sessions of the same course should be distributed evenly across the scheduling period rather than clustering together at the start, end, or around other constraints. The rule divides the scheduling horizon into equal-length epochs — one epoch per required session — and penalizes any epoch that ends up with no session scheduled in it.

   - **Configurable parameters** (set in the Constraints tab):
     - *Penalty Weight (α)* — controls how aggressively spreading is prioritized relative to the consecutive rule. A smaller value keeps spreading as a secondary preference; a larger value enforces it more strongly. Recommended range: 0.01 – 0.5.

   - **How it works:** For a course requiring *N* sessions over the full date range, the horizon is split into *N* equal epochs. Ideally one session falls in each epoch. A penalty of *α* is added to the objective for each epoch that receives no session. Over-filled epochs (more than one session) are not penalized — only gaps are.

   - **Why soft?** Faculty unavailability, conflict groups, and the consecutive rule may make perfectly uniform distribution mathematically infeasible in certain configurations. Modelling it as a weighted penalty allows the solver to achieve the best possible spread without risking infeasibility.

   - **Interaction with the Consecutive Rule:** The two soft constraints are additive in the objective and independent in their constraints. In rare edge cases they may pull in opposite directions — spreading wants a session in every epoch while the consecutive rule penalizes too many adjacent periods. The weight *α* resolves this: keeping it small ensures the consecutive rule remains dominant when both are active.

## Hints

- **The Infeasibility Trap:** It is tempting to make the consecutive-sessions rule a hard constraint. When supply exactly equals demand, this frequently produces an infeasible model with no solution. The core modelling lesson is to relax such constraints into penalized soft constraints via auxiliary binary variables, allowing the solver to find the *best possible* schedule rather than failing entirely.

- **Time Overlaps:** A faculty member can teach the same course to two different sections on the same day, provided it does not violate the maximum daily workload constraint. The no-cloning rule applies only to the exact same date–time window, not to the same day in general.

- **Solver:** The model is solved with [PuLP](https://coin-or.github.io/pulp/) using the bundled CBC integer linear programming solver. A 180-second time limit is applied; for large or heavily-constrained configurations the solver may return a feasible (non-optimal) solution within that limit.

## Setup and Run

1. Clone the repository:

   ```bash
   git clone "https://github.com/DevadattaP/timetable_scheduler.git"
   cd timetable_scheduler
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Run the web server:

   ```bash
   python app.py
   ```

   The application will be available at [`http://localhost:5000`.](http://localhost:5000/)

### For production deployment, you can use [Gunicorn](https://gunicorn.org/)

```bash
gunicorn app:app --timeout 200
```

This will start the server at [`http://localhost:8000`.](http://localhost:8000/) with a 200-second timeout for requests. (since solver has timeout 180 seconds.)

## Features

- Flask web application with a user-friendly interface to configure and generate timetables.
- **Configuration**:
  - **Modes:** The scheduler supports two configuration modes:
   - *Sections mode* — each section has a separate timetable and each section slot may have at most one course, so unused slots are allowed; mappings are `section → course → faculty`.
    - *Areas mode* — configuration is by named areas; areas may host parallel sessions in the same slot (subject to faculty/load/conflict rules); mappings are `course → faculty` (area is taken from the course's `areaShortName`).
  - *Sections/Areas* — define teaching periods and available weekly time slots per section.
  - *Courses* — define courses, credit hours, and required session counts, and *course conflict groups* (define sets of courses that must not run simultaneously, scoped to specific sections).
  - *Faculty* — add faculty members, set daily workload limits, and mark unavailable timeslots.
  - *Mapping* — assign faculty to teach specific courses (for specific sections if sections mode is selected).
  - *Constraints* — review fixed hard constraints, toggle optional constraints, and configure the consecutive sessions soft constraint (max consecutive periods, period unit, reset boundary), spreading sessions soft constraint (weight for penalty).
- Import and export the full configuration (sections/areas, courses, faculty, mappings, conflict groups, constraint settings, and generated timetable) as a structured Excel file. [Sections Template](./static/Sections_timetable_config.xlsx) | [Areas Template](./static/Areas_timetable_config.xlsx)
- The solver minimizes consecutive-period violations or/and minimizes the spreading-period violations under the configured soft constraints; if the rules are disabled, it solves for pure feasibility.
- **Timetable** — view the generated schedule in a filterable pivot table (filter by date, day, time, and section/areas) and export in different ways (sections/area wise or faculty wise or course wise).
- **Verify** the generated timetable against all active constraints and view a week-by-week course distribution heatmap per section.

## Contribute

Contributions are welcome! If you find any bugs or have suggestions for improvements or want to add new features, please open an issue or submit a pull request.
