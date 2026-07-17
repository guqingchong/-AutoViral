import { writable } from "svelte/store";

export interface PublishTarget {
  renderJobId?: string;
  workId?: string;
  mediaPath?: string;
}

export const publishTarget = writable<PublishTarget | null>(null);

export type Tab = "explore" | "works" | "topics" | "digital-humans" | "assets" | "analytics" | "templates" | "jobs" | "publish" | "articles" | "comments" | "evolution" | "admin" | "calendar";

export const activeTab = writable<Tab>("works");
