import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

type Props = SelectHTMLAttributes<HTMLSelectElement> & { containerClassName?: string };

export function SelectField({ className = '', containerClassName = '', ...props }: Props) {
  return <div className={`relative min-w-0 ${containerClassName}`}>
    <select {...props} className={`settings-select h-8 w-full min-w-0 appearance-none truncate rounded-md border-hairline border-[var(--border-subtle)] bg-[var(--app-bg)] pl-2.5 pr-8 text-[13px] text-[var(--text-high)] hover:border-[var(--border-interactive)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-solid)] disabled:opacity-50 ${className}`} />
    <ChevronDown aria-hidden="true" size={14} strokeWidth={1.5}
      className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-medium)] ${props.disabled ? 'opacity-50' : ''}`} />
  </div>;
}
