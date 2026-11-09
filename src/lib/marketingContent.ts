// Customer-facing explanatory content shared by the LLND Mate website pages.
// Every statement here describes behaviour that exists in the current code:
// - LLN: adaptive by section (src/pages/LLNAssessmentPage.tsx processAnswer)
// - Digital: fixed, ordered question set (src/pages/DigitalAssessmentPage.tsx)
// - Learner links need no account (token routes) and progress resumes
// - Below-requirement results open a Candidate Support review case
// - Support plans are drafted from results and approved by staff
// - Compliance reports print / save as PDF; audit trail exports as CSV
// - Results are never used to create enrolments automatically (P1 policy)

export interface FaqItem { q: string; a: string }

export const FAQS: FaqItem[] = [
  {
    q: 'What counts as a completed assessment?',
    a: 'A completed assessment is a learner assignment that has been fully submitted. If a learner completes both LLN and Digital under the same assignment, that counts as one completed assessment. Invitations, reminders and abandoned assessments do not count.',
  },
  {
    q: 'What happens when we reach the LLND Mate free allowance?',
    a: 'LLND Mate includes 10 assessment invitations each month. An invitation counts when it is sent, and an LLN and a Digital assessment sent together count as one. When all 10 are used, new invitations can’t be sent until the next month, but learners already invited can still start and finish. Deleting an assessment sent this month returns its invitation. Invitations to “Test Test” never count. LLND Mate Plus and LLND Automate, with 20 completed assignments included each month, are coming soon.',
  },
  {
    q: 'Are the assessments adaptive?',
    a: 'The LLN assessment is adaptive. Each section starts at a middle level, moves to harder questions when a learner answers consistently well, and finishes once their level is clear, usually within eight questions. The Digital assessment is a short, fixed set of practical questions.',
  },
  {
    q: 'Do learners need to create an account?',
    a: 'No. Each learner receives a personal assessment link. They can complete their assessments on a phone, tablet or computer, and can stop and come back later to continue where they left off.',
  },
  {
    q: 'Does LLND Mate decide whether a learner can enrol?',
    a: 'No. LLND Mate reports results and highlights learners who may need support. Your staff review the results and make every enrolment and support decision.',
  },
  {
    q: 'Will using LLND Mate make our RTO compliant?',
    a: 'No tool can guarantee compliance. LLND Mate gives you a consistent way to review prospective learners’ LLN and digital skills and to keep the evidence. Your RTO remains responsible for how it meets the Standards for RTOs.',
  },
  {
    q: 'Can we download assessment reports?',
    a: 'Yes. Staff can open a compliance report for each completed learner, print it or save it as a PDF, and export the learner’s audit trail as a CSV file.',
  },
  {
    q: 'Are the paid plans available yet?',
    a: 'Not yet. LLND Mate is available now. LLND Mate Plus and LLND Automate are coming soon, and their prices are shown on the pricing page so you can plan ahead.',
  },
];
