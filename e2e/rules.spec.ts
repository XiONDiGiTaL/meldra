import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

async function waitingForPlaying(page: Page): Promise<void> {
  await expect(page.locator('#board')).toHaveAttribute('data-phase', 'playing', { timeout: 20_000 });
}

async function pair(
  browser: Browser,
  mode: 'coop' | 'versus',
): Promise<{ host: Page; guest: Page; code: string; close: () => Promise<void> }> {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await host.goto('/');
  await guest.goto('/');
  await host.getByLabel('Display name').fill('Host');
  await host.locator(`[data-mode="${mode}"]`).click();
  const code = (await host.locator('.room-code .code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  await guest.getByLabel('Display name').fill('Guest');
  await guest.getByLabel('Join a room').fill(code);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(host.locator('.player-name', { hasText: 'Guest' })).toBeVisible();
  await guest.getByRole('button', { name: 'I’m ready' }).click();
  return {
    host,
    guest,
    code,
    close: async () => {
      await hostContext.close();
      await guestContext.close();
    },
  };
}

test('Together rules sync to the guest and the Meld Meter appears in play', async ({ browser }) => {
  const { host, guest, close } = await pair(browser, 'coop');
  const hostRules = host.locator('.rules-card');

  await expect(hostRules.getByText('Room rules')).toBeVisible();
  await hostRules.getByRole('button', { name: 'Endless' }).click();
  await expect(hostRules.getByRole('button', { name: 'Endless' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Endless hides the numeric target chips.
  await expect(hostRules.locator('.rule-chips')).toHaveCount(0);

  const guestRules = guest.locator('.rules-card');
  await expect(guestRules.getByRole('button', { name: 'Endless' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(guestRules.getByRole('button', { name: 'Endless' })).toBeDisabled();
  await expect(guestRules.getByText('The host sets the rules for this room.')).toBeVisible();

  const meterRow = hostRules.locator('.rule-field').filter({ hasText: 'Meld Meter' });
  await meterRow.getByRole('button', { name: 'On', exact: true }).click();
  await expect(guestRules.locator('.rule-field').filter({ hasText: 'Meld Meter' }).getByRole('button', { name: 'On', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await host.getByRole('button', { name: 'Start match' }).click();
  await waitingForPlaying(host);
  await waitingForPlaying(guest);

  await expect(host.locator('.meld-meter')).toBeVisible();
  await expect(guest.locator('.meld-meter')).toBeVisible();
  await expect(host.locator('.meld-meter')).toContainText('Meld Meter');
  await expect(host.locator('.meld-meter')).toBeDisabled();
  // Endless reports the objective in words instead of a bracket target.
  await expect(host.getByText('Survive — no target')).toBeVisible();
  await expect(guest.getByText('Survive — no target')).toBeVisible();

  await close();
});

test('Duel rules: Sudden Death and Clash Attack reach both clients', async ({ browser }) => {
  const { host, guest, close } = await pair(browser, 'versus');
  const hostRules = host.locator('.rules-card');

  await hostRules.getByRole('button', { name: 'Sudden death' }).click();
  await expect(hostRules.locator('.rule-chips')).toHaveCount(0);
  await hostRules.locator('.rule-field').filter({ hasText: 'Clash Attack' }).getByRole('button', { name: 'On', exact: true }).click();

  const guestRules = guest.locator('.rules-card');
  await expect(guestRules.getByRole('button', { name: 'Sudden death' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(guestRules.getByRole('button', { name: 'Sudden death' })).toBeDisabled();

  await host.getByRole('button', { name: 'Start match' }).click();
  await waitingForPlaying(host);
  await waitingForPlaying(guest);

  await expect(host.getByText('First to top out loses')).toBeVisible();
  await expect(guest.getByText('First to top out loses')).toBeVisible();
  await expect(host.locator('.clash-card.on')).toBeVisible();
  await expect(guest.locator('.clash-card.on')).toBeVisible();
  // No charge yet: every attack button is disabled.
  await expect(host.locator('.clash-card.on .btn').first()).toBeDisabled();

  await close();
});
