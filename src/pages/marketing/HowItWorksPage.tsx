import { ArrowRight, Building2, ClipboardCheck, GraduationCap, LifeBuoy, Link2, Smartphone } from 'lucide-react';
import { MarketingShell } from '../../components/marketing/MarketingShell';
import { PRIMARY_CTA, PRIMARY_OFFER, SIGNUP_HASH } from '../../lib/brand';

const STEPS = [
  {
    icon: Building2,
    title: 'Create your free RTO account',
    body: 'Register your organisation online. LLND Mate is free, includes 10 assessment invitations each month and needs no credit card.',
    points: ['Self-service registration', 'Invite your staff by email', 'Separate Administration, Candidate Support and Technical workspaces'],
  },
  {
    icon: GraduationCap,
    title: 'Set the LLND requirements for each course',
    body: 'For each qualification you deliver, your RTO reviews and approves the LLND requirements that learners’ results are compared against.',
    points: ['Requirements approved by your staff', 'Approvals are recorded', 'Results are judged against the approved requirements'],
  },
  {
    icon: Link2,
    title: 'Invite prospective learners',
    body: 'Add a learner and send their personal assessment link by email. Learners do not create an account.',
    points: ['LLN, Digital, or both under one assignment', 'Assessment declaration before starting', 'Reminders for unfinished assessments'],
  },
  {
    icon: Smartphone,
    title: 'Learners complete the assessments',
    body: 'Learners use a phone, tablet or computer. Their progress is saved, so they can stop and continue later.',
    points: [
      'LLN: adaptive sections for reading, writing, numeracy, oral communication and learning',
      'Each LLN section usually finishes within eight questions',
      'Digital: a short, fixed set of practical questions',
      'Learners see each assessment as not started, in progress or completed',
    ],
  },
  {
    icon: ClipboardCheck,
    title: 'Review results',
    body: 'Staff see an estimated ACSF level for each LLN area, the Digital result, and whether the learner meets the course requirements.',
    points: ['Result outcome recorded for each learner', 'Compliance report you can print or save as a PDF', 'Audit trail export as a CSV file'],
  },
  {
    icon: LifeBuoy,
    title: 'Support learners who need it',
    body: 'Learners whose results are below the course requirement are added to the Candidate Support queue. Your team reviews them and decides the next step.',
    points: ['Draft a support plan from the results', 'Edit and approve the plan', 'Enrolment decisions always stay with your staff'],
  },
];

export function HowItWorksPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-sm font-semibold text-primary-700 mb-3">How it works</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-5">How LLND Mate works</h1>
          <p className="text-lg text-slate-600 leading-relaxed">
            From creating your account to supporting learners who need extra help, in six steps.
          </p>
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-16 sm:pb-20" aria-label="Steps">
        <ol className="max-w-4xl mx-auto space-y-6">
          {STEPS.map(({ icon: Icon, title, body, points }, i) => (
            <li key={title} className="rounded-2xl border border-slate-200 p-6 sm:p-8 flex flex-col sm:flex-row gap-6">
              <div className="flex sm:flex-col items-center gap-3 sm:w-24 flex-shrink-0">
                <span className="w-12 h-12 rounded-xl bg-primary-50 text-primary-700 flex items-center justify-center">
                  <Icon className="w-6 h-6" aria-hidden="true" />
                </span>
                <span className="text-sm font-semibold text-slate-500">Step {i + 1}</span>
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900 mb-2">{title}</h2>
                <p className="text-slate-600 leading-relaxed mb-4">{body}</p>
                <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-700">
                  {points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-slate-50 px-4 sm:px-6 py-14 text-center">
        <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3">Ready to try it?</h2>
        <p className="text-slate-600 mb-6">{PRIMARY_OFFER}</p>
        <a href={SIGNUP_HASH} className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors">
          {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </a>
      </section>
    </MarketingShell>
  );
}
