/* eslint-disable @typescript-eslint/no-explicit-any -- additionalScrapeConfigs is operator-owned Prometheus configuration. */

/** Set or remove a managed scrape job in place, so regenerating values keeps the job order stable. */
export function withScrapeJob(jobs: any[], name: string, job?: Record<string, unknown>): any[] {
  const others = jobs.filter(existing => existing?.job_name !== name)
  if (!job) return others
  const position = jobs.findIndex(existing => existing?.job_name === name)
  others.splice(position === -1 ? others.length : position, 0, job)
  return others
}
