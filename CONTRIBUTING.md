# Contributing to walkie-talkie

Thanks for your interest in improving walkie-talkie.

## Prerequisites

- Node.js 22 or newer (`package.json` sets `"engines": { "node": ">=22" }`).
- npm (bundled with Node.js).
- git.

## Get set up

```sh
git clone https://github.com/shimpa1/walkie-talkie.git
cd walkie-talkie
npm ci
```

`npm ci` installs the devDependencies (`typescript` and `@types/node`) from
`package-lock.json`. There are no runtime dependencies.

## Run the local checks

Run these before opening a pull request; all three must pass.

```sh
npm ci             # clean, lockfile-exact install
npm test           # builds, then runs node:test over dist/test
npm run typecheck  # type-checks without emitting
```

`npm test` compiles TypeScript to `dist/` and runs the test suite. The tests
use committed fixtures and a fake firstmate `bin/` directory, so they never
need a live firstmate home.

## Branch and pull request flow

1. Create a topic branch off the latest `main`:

   ```sh
   git checkout main
   git pull --ff-only
   git checkout -b your-topic
   ```

2. Make your change, then run the three checks above.
3. Commit with a clear message and push your branch:

   ```sh
   git push -u origin your-topic
   ```

4. Open a pull request against `main`. Describe what the change does and why,
   and note how you verified it.
5. Keep the branch up to date and address review feedback by pushing new
   commits.

Do not push directly to `main`; every change lands through a pull request.

## Licensing of contributions

walkie-talkie is released under the [Apache License 2.0](LICENSE). By
submitting a pull request or any other contribution, you agree that your
contribution is licensed under the Apache License 2.0, and you confirm that you
have the right to submit it under those terms. See [NOTICE](NOTICE) for
attribution.
