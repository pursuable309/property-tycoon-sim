# property-tycoon-sim

Headless A/B simulation runner for a Property Tycoon (Monopoly-style) CPU AI.

This repository holds no application code on `main`. Each simulation job is pushed
to its own `job/<id>` branch as a one-commit snapshot of the sim code plus a
`job.json`; the `ab` GitHub Actions workflow on that branch runs one matrix cell
per seed × ruleset × arm × shape and commits `results/` back onto the branch.
