// Customer-facing explanatory content shared by the LLND Assess website pages.
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
    q: 'What happens when we reach the Free allowance?',
    a: 'The Free plan includes 10 completed assessments each month. Learners who have already started can still finish. New assessment starts are restricted until the next month. Paid plans with more completions are coming soon.',
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
    q: 'Does LLND Assess decide whether a learner can enrol?',
    a: 'No. LLND Assess reports results and highlights learners who may need support. Your staff review the results and make every enrolment and support decision.',
  },
  {
    q: 'Will using LLND Assess make our RTO compliant?',
    a: 'No tool can guarantee compliance. LLND Assess gives you a consistent way to review prospective learners’ LLN and digital skills and to keep the evidence. Your RTO remains responsible for how it meets the Standards for RTOs.',
  },
  {
    q: 'Can we download assessment reports?',
    a: 'Yes. Staff can open a compliance report for each completed learner, print it or save it as a PDF, and export the learner’s audit trail as a CSV file.',
  },
  {
    q: 'Are the paid plans available yet?',
    a: 'Not yet. The Free plan is available now. Plus and Automate are coming soon, and their prices are shown on the pricing page so you can plan ahead.',
  },
];
