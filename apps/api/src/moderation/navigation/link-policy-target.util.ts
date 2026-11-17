import type { NavigationTargetEvidence } from './navigation-evidence.types';

export function isEnforceableLinkPolicyTarget(target: NavigationTargetEvidence): boolean {
  // FLAG: User/unresolved mention evidence is exempt. A freshly confirmed named
  // chat/channel contributes separate link evidence through max-handle-navigation.
  return target.enforceable && target.kind !== 'profile_mention';
}
