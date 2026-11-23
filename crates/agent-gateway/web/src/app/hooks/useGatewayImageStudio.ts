import { t as translate } from "@liveagent/ui/i18n/index";
import {
  type TrustedGatewayImageIdentity,
  useWebImageStudioHost,
} from "@/agent-ui-adapters/imageStudio";
import { useSingleUserImageIdentity } from "@/lib/imageIdentity";
import type { GatewayAppViewModel } from "../GatewayApp";

/**
 * Image studio host of the chat view. The single-user image identity is
 * verified with the Gateway unless the caller supplies a trusted one.
 */
export function useGatewayImageStudio(
  viewModel: GatewayAppViewModel,
  suppliedIdentity?: TrustedGatewayImageIdentity,
) {
  const identity = useSingleUserImageIdentity(viewModel.imageStudioToken, suppliedIdentity);
  return useWebImageStudioHost(
    viewModel.imageStudioToken,
    identity,
    viewModel.activeWorkspaceProjectPath,
    (key) => translate(key, viewModel.settings.locale),
  );
}
