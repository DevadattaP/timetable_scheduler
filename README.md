# ⏳ Timetable Generator using Linear Programming

Scheduling executive education is highly constrained. Professionals in the program have limited availability, meaning classes are restricted to weekends and specific evenings. Because several sections take the same courses taught by the same faculty members, the administration must carefully balance faculty workloads, avoid timing conflicts, and ensure a pedagogically sound distribution of classes — for example, preventing students from being taught the same subject in too many consecutive weeks without a break.

As a Business Analyst, we formulate this as a mathematical optimization problem and develop an automated scheduling model that generates a feasible and optimal timetable.

## Constraints

### Fixed Hard Constraints (always enforced)

1. **Zero Slack / Exact Fulfillment:** Every section must complete exactly the required number of sessions for each of their courses. Because total supply (available slots) equals total demand (required sessions), every single available time slot must be filled by exactly one class.

2. **One Course per Slot:** Each available time slot for a section is occupied by exactly one course — a direct consequence of the zero-slack condition above.

3. **No Faculty Cloning:** A faculty member cannot teach two different sections at the exact same date and time.

4. **Maximum Daily Workload:** A faculty member can teach a maximum of *N* sessions per calendar day across all sections combined (configurable per faculty member; default is 2).

5. **Course Spacing (Daily):** A specific section cannot be taught the same course more than once in a single day.

### Optional Hard Constraints (can be toggled in the Constraints tab)

6. **Faculty Unavailability:** A faculty member cannot be scheduled on any date listed in their unavailability log.

7. **Course Conflict Groups:** Courses assigned to the same conflict group cannot be scheduled at the same date and time, even across different sections. Conflict groups and the sections they apply to are configurable.

### Soft Constraint / Objective Function (minimized, not strictly enforced)

8. **Consecutive Sessions Rule:** For pedagogical reasons, students need time to digest course material between sessions of the same subject. The rule limits how many consecutive scheduling periods (weeks or days) the same course may be taught to the same section within a given boundary (e.g. within the same calendar month).

   - **Configurable parameters** (set in the Constraints tab):
     - *Max Consecutive* — the maximum number of consecutive periods allowed before a penalty is incurred (e.g. 2 weeks).
     - *Period Unit* — the unit of a "period": weekly or daily.
     - *Reset Boundary* — whether the consecutive counter resets at a calendar boundary such as a month (e.g. two consecutive weeks at the end of January and the start of February are **not** counted as consecutive when the boundary is set to "month").

   - **Why soft?** Due to the zero-slack condition and faculty unavailability, a schedule that perfectly avoids all consecutive-period repetition is often mathematically infeasible. The constraint is therefore modelled as a penalty: minimize the total number of windows in which the same course appears in more than the allowed number of consecutive periods for the same section.

## Hints

- **The Infeasibility Trap:** It is tempting to make the consecutive-sessions rule a hard constraint. Because supply exactly equals demand (every slot must be filled), this frequently produces an infeasible model with no solution. The core modelling lesson is to relax such constraints into penalized soft constraints via auxiliary binary variables, allowing the solver to find the *best possible* schedule rather than failing entirely.

- **Time Overlaps:** A faculty member can teach the same course to two different sections on the same day, provided it does not violate the maximum daily workload constraint. The no-cloning rule applies only to the exact same date–time window, not to the same day in general.

- **Solver:** The model is solved with [PuLP](https://coin-or.github.io/pulp/) using the bundled CBC integer linear programming solver. A 120-second time limit is applied; for large or heavily-constrained configurations the solver may return a feasible (non-optimal) solution within that limit.

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

## Features

- Flask web application with a user-friendly interface to configure and generate timetables.
- **Configure tab** with four subtabs:
  - *Sections* — define teaching periods and available weekly time slots per section.
  - *Courses* — define courses, credit hours, and required session counts, and *course conflict groups* (define sets of courses that must not run simultaneously, scoped to specific sections).
  - *Faculty* — add faculty members, set daily workload limits, and mark unavailable dates.
  - *Mapping* — assign faculty to teach specific courses for specific sections.
  - *Constraints* — review fixed hard constraints, toggle optional constraints, and configure the consecutive sessions soft constraint (max consecutive periods, period unit, reset boundary).
- Import and export the full configuration (sections, courses, faculty, mappings, conflict groups, constraint settings, and generated timetable) as a structured Excel file. [Download Template](./static/Timetable_Config_LP.xlsx)
- The solver minimizes consecutive-period violations under the configured soft constraint; if the rule is disabled, it solves for pure feasibility.
- **Timetable tab** — view the generated schedule in a filterable pivot table (filter by date, day, time, and section).
- **Verify** the generated timetable against all active constraints and view a week-by-week course distribution heatmap per section.

## Contribute

Contributions are welcome! If you find any bugs or have suggestions for improvements or want to add new features, please open an issue or submit a pull request.
