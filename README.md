# Timetable generator using Linear Programming

Scheduling executive education is highly constrained. Professionals in the program have limited availability, meaning classes are restricted to weekends and specific evenings. Furthermore, because several sections take the same courses taught by the same faculty members, the administration must carefully balance faculty workloads, avoid timing conflicts, and ensure a pedagogically sound distribution of classes (e.g., preventing students from taking the same subject every single week without a break).

As a Business Analyst, we should formulate this as a mathematical optimization problem and develop an automated scheduling model that generates a feasible and optimal timetable.

## Constraints (The Rules of the Game)

Your model must adhere to the following rules.

- Hard Constraints (Must be strictly satisfied):-
    1. Zero Slack / Exact Fulfillment: Every section must complete exactly the required number of sessions for each of their courses. Since there are 40 slots available and 40 sessions required, every single available time slot must be filled by exactly one class.
    2. No Faculty Cloning: A faculty member cannot teach two different sections at the exact same time.
    3. Maximum Daily Workload: A faculty member can teach a maximum of two (2) sessions per day across all sections combined. (They are allowed to teach these back-to-back).
    4. Course Spacing (Daily): A specific section cannot be taught the same course more than once in a single day.
    5. Faculty Absences: A faculty member cannot be scheduled on any date listed in their unavailability log. Consider 10 days of unavailability across the dates and faculty. Not just for one person.

- Soft Constraints / Objective Function (To be optimized):
    1. The "Alternate Weekend" Rule: For pedagogical reasons, students need time to digest course material. If a section is taught a specific course in Week $W$, they should not be taught that same course in the immediately following Week $W+1$.
        - Note: Due to the tightness of the schedule (Zero Slack) and faculty unavailability, a perfect "Alternate Weekend" schedule may be mathematically impossible.
        - Objective: Formulate this as a penalty. Minimize the total number of times a course is scheduled in consecutive weeks for the same section.

## Hints

- **The Infeasibility Trap**: Many students will attempt to make the "Alternate Weekend" rule a hard constraint. Because supply exactly equals demand (40 slots = 40 sessions), this will likely result in an "Infeasible" model. Learning how to relax hard constraints into penalized soft constraints via helper variables is the core learning objective of this case.
- **Time Overlaps**: Notice that a professor could teach same subject to two different sections on the same Sunday, provided it doesn't violate the "Max 2 sessions a day" rule.
- **Solver Choice**: Integer Linear Programming (ILP) solvers might struggle with the "consecutive week" logic depending on how it's modeled. Constraint Programming (like Google OR-Tools cp_model) is highly recommended for this specific type of scheduling topology.

## Setup and run project

1. Clone the repository:

   ```bash
   git clone "https://github.com/DevadattaP/timetable-generator.git"
   cd timetable-generator
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Run the web server:

   ```bash
   python app.py
   ```

## Features

- Flask web application with a user-friendly interface to input data and generate timetables.
- Configure sections, courses, faculty, and their mappings in the Configure tab.
- You can even import configuration from an Excel file. [Download Template](./static/Timetable_Config_LP.xlsx)
- PuLP is used in python to solve the linear programming model for timetable generation.
- The solver first attempts a Hard model (no consecutive-week violations).
- If infeasible, it automatically retries with a Soft penalty model.
- The generated timetable is displayed and can be verified for all constraint satisfaction.
- You can export the configuration and the generated timetable to Excel for backup or offline editing.

## Contribute

Contributions are welcome! If you find any bugs or have suggestions for improvements or want to add new features, please open an issue or submit a pull request.
