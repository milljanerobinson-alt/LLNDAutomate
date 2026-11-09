import { useState } from 'react';
import {
  ArrowRight, BookOpen, Calculator, CheckCircle2, ChevronDown, ClipboardCheck, Clock,
  FileText, LifeBuoy, Link2, Monitor, PenLine, MessageCircle, Lightbulb, ShieldCheck,
  Smartphone, UserCheck, Users,
} from 'lucide-react';
import { MarketingShell, SectionIntro } from '../../components/marketing/MarketingShell';
import {
  FREE_TIER_RULES, FREE_MONTHLY_INVITATIONS, TIER_AUTOMATE, TIER_FREE, TIER_PLUS, HOME_DESCRIPTION, HOME_H1, HOW_IT_WORKS_HASH,
  PRIMARY_CTA, PRIMARY_OFFER, PRIMARY_OFFER_SUPPORT, SECONDARY_CTA, SIGNUP_HASH,
} from '../../lib/brand';
import { FAQS } from '../../lib/marketingContent';

// ─── Illustrative learner view (example data, clearly labelled) ──────────────

const EXAMPLE_SECTIONS = [
  { label: 'Reading', icon: BookOpen, level: 3 },
  { label: 'Writing', icon: PenLine, level: 3 },
  { label: 'Numeracy', icon: Calculator, level: 2 },
  { label: 'Oral communication', icon: MessageCircle, level: 4 },
  { label: 'Learning', icon: Lightbulb, level: 3 },
];

function ExampleResultCard() {
  return (
    <figure className="bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">Example learner</p>
          <p className="text-base font-bold text-slate-900">LLN result summary</p>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">Support review</span>
      </div>
      <ul className="px-5 py-4 space-y-3">
        {EXAMPLE_SECTIONS.map(({ label, icon: Icon, level }) => (
          <li key={label} className="flex items-center gap-3">
            <Icon className="w-4 h-4 text-primary-600 flex-shrink-0" aria-hidden="true" />
            <span className="text-sm text-slate-700 w-28 sm:w-40 flex-shrink-0">{label}</span>
            <span className="flex-1 flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`h-2.5 flex-1 rounded-sm ${n <= level ? 'bg-primary-500' : 'bg-slate-100'}`} />
              ))}
            </span>
            <span className="text-sm font-semibold text-slate-900 w-16 text-right">ACSF {level}</span>
          </li>
        ))}
      </ul>
      <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center gap-2 text-sm text-slate-600">
        <Monitor className="w-4 h-4 text-teal-600" aria-hidden="true" />
        Digital assessment: completed
      </div>
      <figcaption className="px-5 py-2 text-xs text-slate-500 border-t border-slate-100">Illustration with example data.</figcaption>
    </figure>
  );
}

// ─── Content ────────────────────────────────────────────────────────────────

const STEPS = [
  { icon: Link2, title: 'Invite the learner', body: 'Add a prospective learner and send their personal assessment link by email. They do not need an account.' },
  { icon: Smartphone, title: 'The learner completes the assessments', body: 'LLN and Digital assessments work on a phone, tablet or computer. Learners can stop and continue later.' },
  { icon: ClipboardCheck, title: 'Review results', body: 'Staff see estimated ACSF levels for each LLN area, the Digital result, and whether the learner meets the requirements set for the course.' },
  { icon: LifeBuoy, title: 'Plan support', body: 'Learners who may need help are flagged for Candidate Support. Draft a support plan, review it and approve it.' },
];

const BENEFITS = [
  { icon: Clock, title: 'Shorter for learners', body: 'Adaptive LLN sections stop once a learner’s level is clear, so learners are not asked more questions than needed.' },
  { icon: UserCheck, title: 'Clear progress for learners', body: 'Learners see each assigned assessment marked as not started, in progress or completed.' },
  { icon: Users, title: 'Simple for your team', body: 'Separate Administration, Candidate Support and Technical workspaces, so each staff member sees what their role needs.' },
  { icon: ShieldCheck, title: 'Your staff stay in control', body: 'Results inform your decisions. LLND Mate never makes enrolment decisions for you.' },
];

// ─── Page ───────────────────────────────────────────────────────────────────

export function FaqList() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {FAQS.map((item, i) => {
        const id = `faq-${i}`;
        const expanded = open === i;
        return (
          <div key={item.q}>
            <h3>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-4 py-5 text-left text-base font-semibold text-slate-900"
                aria-expanded={expanded}
                aria-controls={id}
                onClick={() => setOpen(expanded ? null : i)}
              >
                {item.q}
                <ChevronDown className={`w-5 h-5 text-slate-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            </h3>
            <div id={id} hidden={!expanded} className="pb-5 pr-9 text-slate-600 leading-relaxed">{item.a}</div>
          </div>
        );
      })}
    </div>
  );
}

export function HomePage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      {/* Hero */}
      <section className="bg-gradient-to-b from-primary-50/70 to-white" aria-labelledby="hero-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-14 sm:py-20 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-primary-800 bg-white border border-primary-100 rounded-full px-3.5 py-1.5 mb-6">
              For Australian Registered Training Organisations
            </p>
            <h1 id="hero-heading" className="text-4xl sm:text-5xl font-extrabold text-slate-900 leading-tight tracking-tight mb-5">
              {HOME_H1}
            </h1>
            <p className="text-lg sm:text-xl text-slate-600 leading-relaxed mb-7">{HOME_DESCRIPTION}</p>
            <div className="rounded-2xl border-2 border-primary-200 bg-white p-5 mb-7 shadow-sm">
              <p className="text-lg font-bold text-slate-900">{PRIMARY_OFFER}</p>
              <p className="text-slate-600">{PRIMARY_OFFER_SUPPORT}</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <a href={SIGNUP_HASH} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors shadow-sm">
                {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
              </a>
              <a href={HOW_IT_WORKS_HASH} className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl bg-white border-2 border-slate-200 text-slate-800 font-bold hover:border-slate-300 hover:bg-slate-50 transition-colors">
                {SECONDARY_CTA}
              </a>
            </div>
            <p className="text-sm text-slate-500 mt-4">No credit card needed to create a free account.</p>
          </div>
          <div className="lg:pl-6">
            <ExampleResultCard />
          </div>
        </div>
      </section>

      {/* Why */}
      <section className="py-16 sm:py-20" aria-labelledby="why-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
          <SectionIntro id="why-heading" eyebrow="Why it matters" title="Know a learner’s LLN and digital skills before training starts">
            <p>
              The 2025 Standards for RTOs ask providers to review prospective learners’ skills, including language,
              literacy, numeracy and digital literacy, before enrolment, and to advise whether a course suits them.
              The Standards do not prescribe a single method.
            </p>
          </SectionIntro>
          <div className="space-y-4 text-slate-600 leading-relaxed lg:pt-9">
            <p>
              LLND Mate gives your RTO one consistent, evidence-based way to complete that review: learners take short
              online assessments, and your staff see results against the requirements you set for each course.
            </p>
            <p>
              It supports your process. It does not replace your own judgement, and using it does not by itself make an RTO compliant.
            </p>
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="py-16 sm:py-20 bg-slate-50" aria-labelledby="how-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <SectionIntro id="how-heading" eyebrow="What LLND Mate does" title="From invitation to support plan">
            <p>Everything your team needs to assess prospective learners and act on the results.</p>
          </SectionIntro>
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="bg-white rounded-2xl border border-slate-200 p-6">
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-10 h-10 rounded-xl bg-primary-50 text-primary-700 flex items-center justify-center">
                    <Icon className="w-5 h-5" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-semibold text-slate-500">Step {i + 1}</span>
                </div>
                <h3 className="font-bold text-slate-900 mb-2">{title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8">
            <a href={HOW_IT_WORKS_HASH} className="inline-flex items-center gap-1.5 font-semibold text-primary-700 hover:text-primary-800">
              Read how it works in detail <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          </p>
        </div>
      </section>

      {/* Adaptive */}
      <section className="py-16 sm:py-20" aria-labelledby="adaptive-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-10">
          <SectionIntro id="adaptive-heading" eyebrow="Adaptive assessments" title="Smarter, shorter LLN assessment">
            <p>
              The LLN assessment covers reading, writing, numeracy, oral communication and learning. Each section starts at
              a middle level, moves to harder questions when a learner answers consistently well, and finishes once their
              level is clear, usually within eight questions.
            </p>
          </SectionIntro>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 lg:pt-9">
            <div className="rounded-2xl border border-slate-200 p-6">
              <BookOpen className="w-6 h-6 text-primary-600 mb-3" aria-hidden="true" />
              <h3 className="font-bold text-slate-900 mb-2">LLN assessment</h3>
              <p className="text-sm text-slate-600 leading-relaxed">Adaptive by section. Produces an estimated ACSF level (1 to 5) for each LLN area.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 p-6">
              <Monitor className="w-6 h-6 text-teal-600 mb-3" aria-hidden="true" />
              <h3 className="font-bold text-slate-900 mb-2">Digital assessment</h3>
              <p className="text-sm text-slate-600 leading-relaxed">A short, fixed set of practical questions about everyday digital skills.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Support needs + reports */}
      <section className="py-16 sm:py-20 bg-slate-50" aria-labelledby="support-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <SectionIntro id="support-heading" eyebrow="Support and reporting" title="See who needs support, and keep the evidence">
            <p>Results are compared with the LLND requirements your RTO approves for each course.</p>
          </SectionIntro>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <LifeBuoy className="w-6 h-6 text-amber-600 mb-3" aria-hidden="true" />
              <h3 className="font-bold text-slate-900 mb-2">Learners who need support</h3>
              <p className="text-sm text-slate-600 leading-relaxed">When a result is below the course requirement, the learner is added to the Candidate Support queue for your team to review.</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <ClipboardCheck className="w-6 h-6 text-primary-600 mb-3" aria-hidden="true" />
              <h3 className="font-bold text-slate-900 mb-2">Support plans</h3>
              <p className="text-sm text-slate-600 leading-relaxed">Create a draft support plan from the learner’s results, edit it, and approve it when it is ready.</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <FileText className="w-6 h-6 text-slate-700 mb-3" aria-hidden="true" />
              <h3 className="font-bold text-slate-900 mb-2">Downloadable reports</h3>
              <p className="text-sm text-slate-600 leading-relaxed">Open a compliance report for each completed learner, print it or save it as a PDF, and export the audit trail as a CSV file.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Free allowance */}
      <section className="py-16 sm:py-20" aria-labelledby="free-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
          <SectionIntro id="free-heading" eyebrow="Pricing" title={`${FREE_MONTHLY_INVITATIONS} free assessment invitations every month`}>
            <p>Start on {TIER_FREE} at no cost. {TIER_PLUS} and {TIER_AUTOMATE}, for more assessment volume and premium automation, are coming soon.</p>
          </SectionIntro>
          <div className="rounded-2xl border border-slate-200 p-6 lg:mt-9">
            <h3 className="font-bold text-slate-900 mb-4">How the allowance works</h3>
            <ul className="space-y-3">
              {FREE_TIER_RULES.map((rule) => (
                <li key={rule} className="flex gap-3 text-sm text-slate-700 leading-relaxed">
                  <CheckCircle2 className="w-5 h-5 text-success-600 flex-shrink-0" aria-hidden="true" />
                  {rule}
                </li>
              ))}
            </ul>
            <a href="#/pricing" className="inline-flex items-center gap-1.5 mt-6 font-semibold text-primary-700 hover:text-primary-800">
              Compare plans <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-16 sm:py-20 bg-slate-50" aria-labelledby="benefits-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <SectionIntro id="benefits-heading" eyebrow="Straightforward to use" title="Easy for learners and administrators" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {BENEFITS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-white rounded-2xl border border-slate-200 p-6">
                <Icon className="w-6 h-6 text-primary-600 mb-3" aria-hidden="true" />
                <h3 className="font-bold text-slate-900 mb-2">{title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 sm:py-20" aria-labelledby="faq-heading">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <SectionIntro id="faq-heading" title="Common questions" />
          <FaqList />
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-primary-700 text-white" aria-labelledby="cta-heading">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 text-center">
          <h2 id="cta-heading" className="text-3xl sm:text-4xl font-extrabold mb-4">Start assessing learners today</h2>
          <p className="text-primary-100 text-lg mb-8">{PRIMARY_OFFER} {PRIMARY_OFFER_SUPPORT}</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a href={SIGNUP_HASH} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-primary-800 font-bold hover:bg-primary-50 transition-colors">
              {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
            </a>
            <a href={HOW_IT_WORKS_HASH} className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl border-2 border-white/40 text-white font-bold hover:bg-white/10 transition-colors">
              {SECONDARY_CTA}
            </a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
