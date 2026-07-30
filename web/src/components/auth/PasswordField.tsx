import { Eye, EyeOff } from 'lucide-react'
import { useId, useState, type InputHTMLAttributes } from 'react'
import { FIELD_BASE_CLASSES, FIELD_SIZE_CLASSES, fieldStateClasses, type FieldSize } from '@/components/ui/Input'
import { cx } from '@/lib/cx'

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & {
  label: string
  hint?: string
  error?: string
  size?: FieldSize
  containerClassName?: string
}

/**
 * Password input with show/hide (eye) toggle — used on system setup + login.
 */
export function PasswordField({
  label,
  hint,
  error,
  required,
  size = 'lg',
  className,
  containerClassName,
  id,
  disabled,
  ...props
}: PasswordFieldProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = error ? errorId : hint ? hintId : undefined
  const [visible, setVisible] = useState(false)

  return (
    <div className={cx('flex flex-col gap-1', containerClassName)}>
      <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-text-primary)]">
        {label}
        {required ? <span className="ml-0.5 text-[var(--color-error)]">*</span> : null}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            FIELD_BASE_CLASSES,
            FIELD_SIZE_CLASSES[size],
            fieldStateClasses(!!error),
            'pr-11',
            className,
          )}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          className={cx(
            'absolute right-1.5 top-1/2 -translate-y-1/2',
            'inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]',
            'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
            'hover:bg-[var(--color-surface-container)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
            'disabled:opacity-50',
          )}
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible
            ? <EyeOff className="h-4 w-4" aria-hidden="true" />
            : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      {error
        ? <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">{error}</p>
        : hint
          ? <p id={hintId} className="text-xs text-[var(--color-text-tertiary)]">{hint}</p>
          : null}
    </div>
  )
}
