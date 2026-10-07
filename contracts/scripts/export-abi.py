#!/usr/bin/env python3
"""Export only public ABIs from a successful local build; never deployment addresses."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
subprocess.run(["forge", "build", "--skip", "test", "--skip", "script"], cwd=root, check=True)
(root / "abi").mkdir(exist_ok=True)
names = (
    "RoundRegistry", "PythBoundaryOracle", "IBoundaryOracle",
    "ChainlinkStreamsBoundaryOracle", "IStreamsBoundaryOracle",
    "BaseStreamsPublisher", "HorizenStreamsOracle", "StreamsRoundRegistry",
    "CollateralizedOutcomeVault", "IOutcomeSettlementRegistry",
    "BaseCustodyVault", "HorizenDepositInbox",
)
for name in names:
    artifact = json.loads((root / "out" / f"{name}.sol" / f"{name}.json").read_text())
    (root / "abi" / f"{name}.json").write_text(json.dumps(artifact["abi"], indent=2) + "\n")
print("Exported public contract ABIs; no addresses.")
