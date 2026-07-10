import { writable } from "svelte/store";

export interface PublishTarget {
  renderJobId?: string;
  workId?: string;
  mediaPath?: string;
}

export const publishTarget = writable<PublishTarget | null>(null);
