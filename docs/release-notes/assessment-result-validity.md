# Assessment result validity and safe reuse

**What changes for RTOs**
- New setting (Administration → Organisation → *Assessment result validity*):
  how many days a completed LLN or Digital result can be reused, counted from
  that module's own completion date. There is no default. Until a period is
  set, earlier results are never reused automatically; they're held for your
  review.
- A previous result is reused only if every check passes:
  - it belongs to this learner within your RTO;
  - its own completion date is present, valid and not in the future;
  - it's within your validity period;
  - the current enrolment's course is identified;
  - the course's ACSF mapping is approved by your RTO for its current levels,
    and no training.gov.au change has been recorded since. Approval doesn't
    expire with time;
  - LLN: every required ACSF skill is met. Digital: the pass mark of the
    Digital assessment sat is met.
- LLN and Digital are decided separately. If only one needs reassessment, the
  other is kept.
- Expired or below-requirement results → a new assessment for that module.
  Anything that can't be checked → *Review required* on the aXcelerate inbound
  page, with the reason.
- A learner already accepted for an enrolment is not reassessed mid-course
  just because time passes; repeated sync events never trigger reassessment.
  If the course's approved levels change, or an older record doesn't pass a
  re-check, it's held for your review rather than reassessed automatically.
  A changed validity period applies to new enrolments.
- ACSF mapping approval (Qualifications page):
  - shows who approved it, when, and the training.gov.au release reviewed;
  - keeps the full decision history;
  - when a training.gov.au change is recorded, shows what changed and holds
    reuse until you approve again;
  - your approved levels are never replaced by generated suggestions; a
    suggestion is recorded for you to review.
- Candidate completion times are stamped by the server, and a completed
  result can't be changed through the assessment link.
- Student matching is stricter:
  - aXcelerate contact ID first;
  - then exact name and date of birth;
  - then email, only where dates of birth don't conflict.
  It never takes over a record linked to another contact; possible duplicates
  are held for review.
- The aXcelerate contact note says "Existing LLND assessment results have been
  reviewed and meet the current LLND requirements for this course" only when
  every check passed, with dates and levels. Otherwise it gives the
  reassessment or pending-review status and the reason. It's written once, and
  again only if the outcome changes.
- Learners the aXcelerate sync finds already enrolled are no longer enrolled
  again in "the first available" course instance by the write-back queue.

**Fixed along the way**
- The LLN requirement check compared results with the wrong field. Any course
  with Reading, Writing, Learning or Oral Communication requirements always
  counted as "not met".
- Earlier results were found by date of birth alone.
- The "ACSF 2 in any skill" fallback no longer approves reuse.
- The 15-minute retry back-off after an aXcelerate error was never saved.
