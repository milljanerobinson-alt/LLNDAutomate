import { ArrowRight } from 'lucide-react';
import { UPGRADE_OPTIONS_HASH } from '../lib/planUsage';

/**
 * "Explore upgrade options": opens the existing pricing / plan comparison page.
 * It never starts checkout or changes a plan (paid plans are "Coming soon").
 */
export function UpgradeOptionsButton() {
  return (
    <a href={UPGRADE_OPTIONS_HASH} data-testid="upgrade-options"
      className="inline-flex items-center justify-center gap-2 w-full sm:w-auto mt-3 px-5 py-2.5 rounded-full bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900">
      Explore upgrade options <ArrowRight className="w-4 h-4" aria-hidden="true" />
    </a>
  );
}
