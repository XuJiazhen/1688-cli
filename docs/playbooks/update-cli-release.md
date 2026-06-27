# Playbook: Update CLI Release Behavior

Use this playbook for version bumps, npm publishes, GitHub release/tag work,
postinstall changes, and update-notifier behavior.

## Release Checklist

1. Update `CHANGELOG.md` first.
   - Keep current in-progress docs/features under `## [Unreleased]`.
   - Before publishing, move released items into
     `## [x.y.z] - YYYY-MM-DD`.
   - Do not describe post-tag work as part of an already-published npm version.
2. Check `package.json`, `README.md`, npm metadata, and update-notifier behavior
   in `src/cli.ts`.
   - Keep translated root README files from matching npm's `README.*`
     selector. Use a name such as `README_zh-CN.md` or place translations
     under `docs/`, otherwise npm may publish the translation as the package
     default README.
3. Preserve the update protocol in `docs/SAFETY.md`: never run a global install
   command without explicit current-turn user approval.
4. If daemon behavior changes after upgrade, document whether
   `1688 daemon reload` is required.
5. Run:

   ```bash
   pnpm agent-context
   pnpm agent-verify
   npm pack --dry-run
   ```

6. Verify the release gate explicitly:

   ```bash
   pnpm release-check
   ```

7. Check npm auth, but do not publish from the agent session. npm publishing is
   human-owned for this project:

   ```bash
   npm whoami --registry https://registry.npmjs.org/
   ```

   If the check succeeds, give the human this command:

   ```bash
   npm publish --registry https://registry.npmjs.org/
   ```

   If the check fails, give the human these commands:

   ```bash
   npm login --registry https://registry.npmjs.org/
   npm publish --registry https://registry.npmjs.org/
   ```

   npm will handle any required interactive authentication or confirmation. Do
   not include `--otp`. `--access public` is not required for the unscoped
   `1688-cli` package.

8. Push both branch and tag. Lightweight tags are not pushed by
   `git push --follow-tags`, so push the release tag explicitly:

   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

9. After the human confirms npm publish is complete, verify:

   ```bash
   npm view 1688-cli version dist-tags --registry https://registry.npmjs.org/ --json
   npm view 1688-cli@X.Y.Z readmeFilename version --registry https://registry.npmjs.org/ --json
   git ls-remote --tags origin refs/tags/vX.Y.Z
   ```

   `readmeFilename` should be `README.md` unless intentionally changed.

## Omission Tracking

If a release step is missed, record it in
`docs/records/release-omissions.md` with symptom, cause, fix, and prevention.
Then update this playbook or a script so the same omission becomes harder to
repeat.
