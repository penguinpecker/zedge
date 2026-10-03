// Read-only subset generated from contracts/abi. No write functions are exposed.
export const registryReadAbi = [
  {
    "type": "function",
    "name": "PAYOUT_DENOMINATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "btcExponent",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int32",
        "internalType": "int32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "btcFeedId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "canTrade",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "collateral",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cutoffBuffer",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deploymentChainId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ethExponent",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int32",
        "internalType": "int32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ethFeedId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRound",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct RoundRegistry.Round",
        "components": [
          {
            "name": "asset",
            "type": "uint8",
            "internalType": "enum RoundRegistry.Asset"
          },
          {
            "name": "duration",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "end",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "cutoff",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "openingDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resolutionDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "openedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resolvedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum RoundRegistry.Outcome"
          },
          {
            "name": "opening",
            "type": "tuple",
            "internalType": "struct IBoundaryOracle.Observation",
            "components": [
              {
                "name": "price",
                "type": "int64",
                "internalType": "int64"
              },
              {
                "name": "confidence",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "exponent",
                "type": "int32",
                "internalType": "int32"
              },
              {
                "name": "publishTime",
                "type": "uint64",
                "internalType": "uint64"
              }
            ]
          },
          {
            "name": "closing",
            "type": "tuple",
            "internalType": "struct IBoundaryOracle.Observation",
            "components": [
              {
                "name": "price",
                "type": "int64",
                "internalType": "int64"
              },
              {
                "name": "confidence",
                "type": "uint64",
                "internalType": "uint64"
              },
              {
                "name": "exponent",
                "type": "int32",
                "internalType": "int32"
              },
              {
                "name": "publishTime",
                "type": "uint64",
                "internalType": "uint64"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxConfidenceBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "observationWindow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openingGrace",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "oracle",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IBoundaryOracle"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "payoutNumerators",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "up",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "down",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "denominator",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "phase",
    "inputs": [
      {
        "name": "roundId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum RoundRegistry.Phase"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "roundIdFor",
    "inputs": [
      {
        "name": "asset",
        "type": "uint8",
        "internalType": "enum RoundRegistry.Asset"
      },
      {
        "name": "duration",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "start",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "rulesHash",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settlementGrace",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "version",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "pure"
  }
] as const;
export const oracleReadAbi = [
  {
    "type": "function",
    "name": "MAX_EVIDENCE_BYTES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_UPDATES",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pyth",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPyth"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteFee",
    "inputs": [
      {
        "name": "evidence",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "version",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "pure"
  }
] as const;
