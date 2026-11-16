const REMOTE_SCRIPTS = 'https://raw.githubusercontent.com/deskid/tabflow/main/scripts';
const STORE_EXTENSION_ID = 'pnjgkehmcfheoecnhenfeidkpkdjifkm';

export function getNativeInstallCommand(userAgent: string, extensionId = STORE_EXTENSION_ID): string {
  const id = extensionId || STORE_EXTENSION_ID;
  if (/mac/i.test(userAgent)) {
    return id !== STORE_EXTENSION_ID
      ? `curl -fsSL ${REMOTE_SCRIPTS}/install-native-host.sh | bash -s -- ${id}`
      : `curl -fsSL ${REMOTE_SCRIPTS}/install-native-host.sh | bash`;
  }
  return '& { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; '
    + `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -Uri '${REMOTE_SCRIPTS}/install-native-host.ps1' -ErrorAction Stop).Content)) -ExtensionId ${id} }`;
}
