import { GraduationCap } from 'lucide-react';
import { PRODUCT_NAME } from '../../lib/brand';

interface BrandMarkProps {
  /** 'dark' for light backgrounds, 'light' for dark backgrounds. */
  tone?: 'dark' | 'light';
  size?: 'sm' | 'md';
  showDescriptor?: boolean;
}

/** LLND Assess logo lock-up: icon + wordmark. Decorative icon; the name is the accessible label. */
export function BrandMark({ tone = 'dark', size = 'md', showDescriptor = false }: BrandMarkProps) {
  const box = size === 'sm' ? 'w-8 h-8 rounded-lg' : 'w-9 h-9 rounded-xl';
  const icon = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  return (
    <span className="flex items-center gap-2.5">
      <span className={`${box} bg-primary-600 flex items-center justify-center shadow-sm flex-shrink-0`}>
        <GraduationCap className={`${icon} text-white`} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-none text-left">
        <span className={`font-extrabold tracking-tight ${size === 'sm' ? 'text-sm' : 'text-base'} ${tone === 'dark' ? 'text-slate-900' : 'text-white'}`}>
          LLND <span className={tone === 'dark' ? 'text-primary-600' : 'text-primary-300'}>Assess</span>
          <span className="sr-only"> ({PRODUCT_NAME})</span>
        </span>
        {showDescriptor && (
          <span className={`text-[11px] font-medium mt-1 hidden sm:block ${tone === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>
            LLN &amp; Digital assessments
          </span>
        )}
      </span>
    </span>
  );
}
