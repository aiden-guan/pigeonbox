import { useTransfer } from './continuity';
import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
export function Button({ tone = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' }) {
  return <button type="button" {...props} className={`${tone === 'quiet' ? 'gi-text-btn' : `gi-btn${tone === 'secondary' ? ' gi-btn-ghost' : ''}`} ${className}`} />;
}
export function IconButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...props} className={`pb-icon-btn ${className}`} />;
}
export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`gi-field ${className}`} />; }
export function Surface({ className = '', ...props }: HTMLAttributes<HTMLElement>) { return <section {...props} className={`pb-surface ${className}`} />; }
export function Status({ tone = 'quiet', children }: { tone?: 'quiet' | 'success' | 'attention' | 'error'; children: ReactNode }) { return <span className="pb-status-label" data-tone={tone}><i aria-hidden="true" />{children}</span>; }
export function ContextCard({ subject, sender, motionKey = '' }: { subject: string; sender?: string; motionKey?: string }) { const ref = useTransfer<HTMLDivElement>(motionKey); return <div ref={ref} className="pb-context-card" aria-label="Email context"><span className="pb-context-mark" aria-hidden="true">↳</span><div>{sender ? <small data-continuity="sender">{sender}</small> : null}<strong data-continuity="subject">{subject || 'Current conversation'}</strong></div></div>; }
