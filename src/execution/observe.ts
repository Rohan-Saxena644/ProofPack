import type { Page, Locator } from 'playwright';
import type { Control, Observation } from '../core/contracts';
import { safeUrl } from './boundaries';

export async function observe(page: Page, redact: (s: string) => string): Promise<Observation> {
  const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('input,button,a[href],select,textarea,[role="button"],[role="link"],[role="textbox"]')].filter(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }).slice(0, 70).map((el, i) => {
      const field = el as HTMLInputElement;
      const labels = 'labels' in el ? [...((el as HTMLInputElement).labels ?? [])].map(l => l.innerText).join(' ') : '';
      const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      const name = (el.getAttribute('aria-label') || labelled || labels || (['BUTTON', 'A'].includes(el.tagName) ? (el as HTMLElement).innerText : '') || el.getAttribute('placeholder') || '').trim().slice(0, 160);
      const role = el.getAttribute('role') || (el.tagName === 'BUTTON' || ['submit', 'button'].includes(field.type) ? 'button' : el.tagName === 'A' ? 'link' : el.tagName === 'SELECT' ? 'combobox' : field.type === 'checkbox' ? 'checkbox' : 'textbox');
      return { id: `c${i}`, role, name, tag: el.tagName.toLowerCase(), inputType: field.type || '', testId: el.getAttribute('data-testid'), secret: field.type === 'password', options: el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map(o => o.label).slice(0, 25) : [] };
    });
    return { text: document.body.innerText.slice(0, 10000), controls };
  });
  return { url: safeUrl(page.url()), text: redact(result.text), controls: result.controls.map(c => ({ ...c, name: redact(c.name) })) };
}
export function resolveControl(page: Page, c: Control): { locator: Locator; description: string } {
  if (c.name) {
    if (['input', 'textarea', 'select'].includes(c.tag)) return { locator: page.getByLabel(c.name, { exact: true }), description: `label=${c.name}` };
    return { locator: page.getByRole(c.role as 'button', { name: c.name, exact: true }), description: `role=${c.role}, name=${c.name}` };
  }
  if (c.testId) return { locator: page.getByTestId(c.testId), description: `testId=${c.testId}` };
  throw new Error('Observed control has no usable accessible name or test ID.');
}
