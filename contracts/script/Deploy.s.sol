// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";

/// @notice Deploys FermataEscrow. Run through `scripts/deploy-escrow.sh`, which loads `.env`,
/// broadcasts with `--network tempo` and records the result in packages/sdk/src/deployments.json.
///   DEPLOYER_PRIVATE_KEY  required
///   FERMATA_OWNER         default: the deployer
///   FERMATA_TREASURY      default: the deployer
///   FERMATA_FEE_BPS       default: 50 (0.5 %), at most 500
contract Deploy is Script {
    function run() external returns (FermataEscrow escrow) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("FERMATA_OWNER", deployer);
        address treasury = vm.envOr("FERMATA_TREASURY", deployer);
        uint256 feeBps = vm.envOr("FERMATA_FEE_BPS", uint256(50));
        require(feeBps <= 500, "FERMATA_FEE_BPS above 500");

        vm.startBroadcast(pk);
        // forge-lint: disable-next-line(unsafe-typecast) — checked ≤ 500 above
        escrow = new FermataEscrow(owner, treasury, uint16(feeBps));
        vm.stopBroadcast();

        console.log("FermataEscrow", address(escrow));
        console.log("owner", owner);
        console.log("treasury", treasury);
        console.log("feeBps", feeBps);
    }
}
