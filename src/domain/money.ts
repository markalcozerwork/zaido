/**
 * Philippine peso helpers. Amounts are numbers with at most 2 decimals, the
 * same shape PostgREST returns for numeric(10,2). All arithmetic goes through
 * integer centavos to avoid float drift (0.1 + 0.2).
 */
import { z } from "zod";
import { LIMITS } from "./limits";

export function isWholeCentavos(amount: number): boolean {
  return Number.isFinite(amount) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

export const toCentavos = (amount: number): number => Math.round(amount * 100);
export const fromCentavos = (centavos: number): number => centavos / 100;

/** Exact sum of peso amounts. */
export function addPesos(...amounts: readonly number[]): number {
  return fromCentavos(amounts.reduce((sum, a) => sum + toCentavos(a), 0));
}

/** Peso amount from 0 up to `max` (default: the rate/fee cap used by the DB). */
export function pesoAmountSchema(max: number = LIMITS.money.max) {
  return z
    .number({ error: "Enter an amount in pesos." })
    .min(0, { error: "Amount cannot be negative." })
    .max(max, { error: `Amount cannot exceed ${formatPeso(max)}.` })
    .refine(isWholeCentavos, { error: "Use at most 2 decimal places." });
}

const pesoFormatter = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const wholePesoFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

/**
 * ₱ formatting for the UI: `formatPeso(1250.5)` → "₱1,250.50".
 * With `{ compact: true }`, whole amounts drop the centavos: "₱400".
 */
export function formatPeso(amount: number, options: { compact?: boolean } = {}): string {
  if (options.compact && toCentavos(amount) % 100 === 0) return wholePesoFormatter.format(amount);
  return pesoFormatter.format(amount);
}
