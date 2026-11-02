import { z } from 'zod';
import {
  chatParticipantItemSchema,
  chatParticipantRoleSchema,
} from './chat-participant-profile.js';

export const chatParticipantDetailsSchema = chatParticipantItemSchema.extend({
  role: chatParticipantRoleSchema.nullable(),
  membershipStatus: z.enum(['member', 'left', 'unknown']),
  canManage: z.boolean(),
  canMute: z.boolean().optional(),
  canBan: z.boolean().optional(),
});
export type ChatParticipantDetails = z.infer<typeof chatParticipantDetailsSchema>;
