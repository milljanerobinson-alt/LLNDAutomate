# Assessment result validity and safe reuse

**What changes for RTOs**
- New setting (Administration → Organisation → *Assessment result validity*):
  how many days a completed LLN or Digital result can be reused for a new
  enrolment, counted from that assessment's own completion date. There is no
  default. Until you set a period, earlier results are never reused
  automatically; they're held for your review.
- A previous result is reused only if:
  - it has a real completion date that isn't in the future;
  - it's within your validity period;
  - the qualification is identified;
  - it meets that qualification's requirements (LLN: every required ACSF
    skill; Digital: the pass mark of the assessment sat).
- Expired or insufficient results → a new assessment is sent. Results that
  can't be checked → *Review required* on the aXcelerate inbound page, with
  the reason.
- Older "already processed" records are checked again once, as at the date
  they were first processed. A result that was valid then stands, so learners
  aren't reassessed mid-course. One that was already out of date is
  reassessed.
- Student matching is stricter:
  - aXcelerate contact ID first;
  - then exact name and date of birth;
  - then email, only where dates of birth don't conflict.
  It never takes over a record linked to another contact, and it never
  guesses: possible duplicates are held for review.
- The aXcelerate contact note now says exactly what was checked: completion
  date, validity period and end date, and the ACSF levels or Digital score
  against what was required. It's written once, and again only if the outcome
  changes.

**Fixed along the way**
- The LLN requirement check compared results with the wrong field. Any
  qualification with Reading, Writing, Learning or Oral Communication
  requirements always counted as "not met".
- Earlier results were found by date of birth alone. Another learner with the
  same birthday could have had their result reused.
- The 15-minute retry back-off after an aXcelerate error was never saved,
  because the log didn't accept the "error" status.
