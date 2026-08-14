import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";

export function createGatewaySftpClient(api: GatewayWebSocketClientLike): SftpClient {
  return {
    list(params) {
      return api.sftpList(params);
    },
    stat(params) {
      return api.sftpStat(params);
    },
    mkdir(params) {
      return api.sftpMkdir(params);
    },
    rename(params) {
      return api.sftpRename(params);
    },
    delete(params) {
      return api.sftpDelete(params);
    },
    transfer(params) {
      return api.sftpTransfer(params);
    },
    cancelTransfer(params) {
      return api.sftpCancelTransfer(params);
    },
    readText(params) {
      return api.sftpReadText(params);
    },
    writeText(params) {
      return api.sftpWriteText(params);
    },
    subscribeTransfers(listener) {
      return api.subscribeSftpTransfers(listener);
    },
  };
}
