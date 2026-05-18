# Legal Release Checklist

## 1. Prepare Document Changes
- [ ] Update docs/privacy/terms-and-conditions.html if Terms changed.
- [ ] Update docs/privacy/privacy-policy.html if Privacy changed.
- [ ] Update Version, Effective Date, and Last Updated on changed pages.
- [ ] Verify legal text is approved and final.

## 2. Archive New Version
- [ ] Create docs/privacy/archive/vX.Y.Z/
- [ ] Copy Terms page into archive folder.
- [ ] Copy Privacy page into archive folder.
- [ ] Add release-notes.md into archive folder.

## 3. Changelog
- [ ] Add a new entry at top of docs/privacy/CHANGELOG.md.
- [ ] Include summary, approval, and git reference placeholders.

## 4. Git Release
- [ ] git add docs/privacy
- [ ] git commit -m "legal: release vX.Y.Z (effective YYYY-MM-DD)"
- [ ] git tag -a legal-vX.Y.Z -m "Legal release vX.Y.Z"
- [ ] git push
- [ ] git push --tags

## 5. Verify Published Pages
- [ ] Open Terms URL and verify version/date.
- [ ] Open Privacy URL and verify version/date.
- [ ] Confirm archive folder contains the correct snapshot files.
