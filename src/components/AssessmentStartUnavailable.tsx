import { CalendarClock } from 'lucide-react';

/**
 * Shown to a learner when the server refuses a new assessment start.
 * Deliberately says nothing about the RTO's plan, usage or subscription.
 * Saved answers and progress are not touched.
 */
export function AssessmentStartUnavailable() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 sm:p-10 max-w-md w-full text-center" role="alert">
        <div className="w-16 h-16 rounded-2xl bg-primary-50 flex items-center justify-center mx-auto mb-4">
          <CalendarClock className="w-8 h-8 text-primary-600" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">This assessment can’t be started right now</h1>
        <p className="text-slate-600 text-sm leading-relaxed">
          Your training organisation isn’t able to open new assessments at the moment. Nothing is wrong with your link,
          and anything you have already saved is kept.
        </p>
        <p className="text-slate-600 text-sm leading-relaxed mt-3">
          Please contact your trainer or training organisation to find out when you can start.
        </p>
      </div>
    </div>
  );
}
