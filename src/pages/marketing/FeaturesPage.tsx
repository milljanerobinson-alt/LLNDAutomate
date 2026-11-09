import { ArrowRight, BookOpen, ClipboardCheck, FileText, LifeBuoy, Lock, Mail, Monitor, RotateCcw, Smartphone, Target, Users } from 'lucide-react';
import { MarketingShell } from '../../components/marketing/MarketingShell';
import { PRIMARY_CTA, SIGNUP_HASH } from '../../lib/brand';

const GROUPS = [
  {
    heading: 'Assessments',
    items: [
      { icon: BookOpen, title: 'Adaptive LLN assessment', body: 'Reading, writing, numeracy, oral communication and learning. Each section adjusts to the learner and usually finishes within eight questions.' },
      { icon: Monitor, title: 'Digital assessment', body: 'A short, fixed set of practical questions about everyday digital skills.' },
      { icon: Target, title: 'ACSF levels', body: 'LLN results give an estimated ACSF level from 1 to 5 for each area.' },
    ],
  },
  {
    heading: 'For learners',
    items: [
      { icon: Mail, title: 'Personal assessment link', body: 'Learners open their assessments from an emailed link. No account or password needed.' },
      { icon: Smartphone, title: 'Works on any device', body: 'Phone, tablet or computer.' },
      { icon: RotateCcw, title: 'Save and continue', body: 'Progress is saved, so learners can stop and come back later.' },
    ],
  },
  {
    heading: 'For your team',
    items: [
      { icon: ClipboardCheck, title: 'Course requirements', body: 'Approve the LLND requirements for each qualification. Results are compared against the approved requirements.' },
      { icon: LifeBuoy, title: 'Candidate Support queue', body: 'Learners below a course requirement are queued for your team to review, with draft support plans you can edit and approve.' },
      { icon: FileText, title: 'Reports and evidence', body: 'Compliance report for each completed learner that you can print or save as a PDF, plus an audit trail export as a CSV file.' },
      { icon: Users, title: 'Staff workspaces', body: 'Administration, Candidate Support and Technical workspaces. Invite staff by email and give each person the access they need.' },
      { icon: Lock, title: 'Your RTO’s data stays separate', body: 'Each RTO can only see its own learners, results and settings.' },
    ],
  },
];

export function FeaturesPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-sm font-semibold text-primary-700 mb-3">Features</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-5">What’s included in LLND Mate</h1>
          <p className="text-lg text-slate-600 leading-relaxed">Everything listed here is available on LLND Mate, the free plan.</p>
        </div>
      </section>
      {GROUPS.map((g) => (
        <section key={g.heading} className="px-4 sm:px-6 pb-14" aria-labelledby={`grp-${g.heading}`}>
          <div className="max-w-6xl mx-auto">
            <h2 id={`grp-${g.heading}`} className="text-2xl font-extrabold text-slate-900 mb-6">{g.heading}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {g.items.map(({ icon: Icon, title, body }) => (
                <div key={title} className="rounded-2xl border border-slate-200 p-6">
                  <Icon className="w-6 h-6 text-primary-600 mb-3" aria-hidden="true" />
                  <h3 className="font-bold text-slate-900 mb-2">{title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
      <section className="bg-slate-50 px-4 sm:px-6 py-14">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl font-extrabold text-slate-900 mb-3">Coming with LLND Mate Plus and LLND Automate</h2>
          <p className="text-slate-600 mb-6">Premium integration automation is planned for LLND Automate. It is not available yet.</p>
          <a href={SIGNUP_HASH} className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors">
            {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </a>
        </div>
      </section>
    </MarketingShell>
  );
}
