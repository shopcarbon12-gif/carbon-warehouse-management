/// Chainway RSCJA hardware bridge.
///
/// Android `MethodChannel` bindings will live here so the main app stays free
/// of vendor SDK surface area.
library carbon_chainway_driver;

/// Placeholder for native channel name (implement when wiring Android).
const String kChainwayChannelName = 'carbon_wms/chainway_rfid';

/// Reserved for future: version handshake with native layer.
class ChainwayDriverPlaceholder {
  const ChainwayDriverPlaceholder();
}
