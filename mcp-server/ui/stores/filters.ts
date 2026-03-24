import { writable } from "svelte/store";

export const activeLayers = writable<string[]>([]);
export const searchQuery = writable("");
export const activeInsightFilter = writable<Set<string> | null>(null);
export const activePrReview = writable<any>(null);
export const prReviewFiles = writable<Set<string> | null>(null);
export const showChangedOnly = writable(false);
