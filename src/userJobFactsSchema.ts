import { z } from 'zod/v4'
import { normalizedUserJobFacts } from './opportunityCreation.js'

export const userJobFactsShape = {
  company: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(180),
  sourceUrl: z.string().trim().url().max(2000).optional(),
  sourceTitle: z.string().trim().min(1).max(240).optional(),
  location: z.string().trim().min(1).max(240).optional(),
  deadline: z.string().trim().min(1).max(80).optional(),
  deadlinePrecision: z.enum(['date', 'datetime']).optional(),
  compensationText: z.string().trim().min(1).max(500).optional(),
}
export const userJobFactsSchema = z.object(userJobFactsShape).strict().superRefine((value, context) => {
  try { normalizedUserJobFacts(value) } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid job facts.' })
  }
})
