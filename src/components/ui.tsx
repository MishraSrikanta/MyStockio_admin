import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/**
 * The handful of primitives this console needs.
 *
 * Deliberately small. An admin tool used for a few minutes at a time does not earn a component
 * library, and four screens sharing five components is easier to follow than four screens sharing
 * a framework.
 */

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'success'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sky-500 text-white hover:bg-sky-400',
  outline: 'border border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500',
  ghost: 'text-slate-300 hover:bg-slate-800 hover:text-slate-100',
  danger: 'bg-rose-600 text-white hover:bg-rose-500',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
}

export function Button({
  variant = 'outline',
  size = 'md',
  icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: ReactNode
  loading?: boolean
}) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9.5 px-3.5 py-2 text-[14px]',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : icon}
      {children}
    </button>
  )
}

export function Input({
  label,
  hint,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <label className="block min-w-0">
      {label && <span className="label">{label}</span>}
      <input {...rest} className={cn('field', error && 'border-rose-500 focus:border-rose-500', className)} />
      {error ? (
        <span className="mt-1 block text-[12px] font-medium text-rose-400">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-slate-500">{hint}</span>
      ) : null}
    </label>
  )
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'violet'

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-700/40 text-slate-300',
  success: 'bg-emerald-500/15 text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-300',
  danger: 'bg-rose-500/15 text-rose-300',
  info: 'bg-sky-500/15 text-sky-300',
  violet: 'bg-violet-500/15 text-violet-300',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11.5px] font-bold', TONES[tone])}>
      {children}
    </span>
  )
}

export function Stat({ label, value, tone = 'neutral', onClick }: { label: string; value: number; tone?: Tone; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'card min-w-0 px-3 py-2.5 text-left transition-colors',
        onClick && 'hover:border-slate-600',
        !onClick && 'cursor-default',
      )}
    >
      <p className="truncate text-[11.5px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className={cn('num mt-0.5 text-[22px] font-bold leading-none', TONES[tone].split(' ')[1])}>{value}</p>
    </button>
  )
}

/**
 * A dialog.
 *
 * No portal and no focus trap: this is a single-purpose internal tool, and the alternative is a
 * dependency or a hundred lines of accessibility plumbing for four modals. Escape closes, and the
 * backdrop does not — an accidental click beside a half-typed payment should not discard it.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  printRoot,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Marks this dialog as the thing being printed — see the @media print rules in index.css. */
  printRoot?: boolean
}) {
  if (!open) return null
  return (
    <div
      className={cn('fixed inset-0 z-50 flex items-end justify-center sm:items-center', printRoot && 'print-root')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="no-print absolute inset-0 bg-slate-950/80" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden border-slate-800 bg-slate-900 shadow-2xl',
          'rounded-t-2xl border-t sm:rounded-2xl sm:border',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <header className="no-print flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <h2 className="min-w-0 text-[15px] font-bold text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-100" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
        {footer && <footer className="no-print flex flex-wrap justify-end gap-2 border-t border-slate-800 px-4 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

/** A message that stays until it is dismissed. Errors here are worth reading, not glimpsing. */
export function Notice({ tone, children, onDismiss }: { tone: 'danger' | 'success' | 'warning' | 'info'; children: ReactNode; onDismiss?: () => void }) {
  const style = {
    danger: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  }[tone]

  return (
    <div className={cn('flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[13px] leading-relaxed', style)}>
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  )
}
