# Issue #45 — Platform operator access

**For RTOs**
- A new *Platform support access* section on the Organisation page (Administration
  workspace) lists every time LLND Automate platform support looked at your
  organisation: who, why, when, and what kind of information. Support access is
  read-only and never includes passwords, keys or other secrets.
- Nothing changes in your three workspaces.

**For the platform operator**
- EIOS and RTO support now need an operator grant (made in the Supabase SQL
  Editor) and an authenticator-app code at sign-in.
- *RTO support* (`/eios#/operator/support`): choose an RTO, give a reason, and
  work for up to 60 minutes. A banner shows who you are supporting and when the
  session ends; End session stops access immediately.
- Holding all three RTO workspaces, or the old `admin` profile role, no longer
  opens EIOS.

**Security**
- EIOS database tables are now operator-only; anonymous access is removed.
- Functions that save platform secrets require an MFA-verified operator.
