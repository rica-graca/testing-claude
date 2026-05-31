---
labels: auth, sprint-3
context_files: src/auth/login.js, src/models/user.js
---

Users need to be able to manage their own account settings. This includes
updating their display name and email address, changing their password with
current-password verification, uploading a profile avatar (max 2MB, jpg/png),
and permanently deleting their account after a confirmation step.

The password change flow must invalidate all existing sessions except the current one.
Email changes require re-verification before taking effect.
Account deletion should soft-delete for 30 days before permanent removal.
