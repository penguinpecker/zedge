// Exact read-only ABI subset from the compiled Solidity 0.8.30 / Paris artifacts.

export const streamsRegistryReadAbi = [
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
    "name": "UPGRADE_INTERFACE_VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "btcDecimals",
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
    "name": "ethDecimals",
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
        "internalType": "struct StreamsRoundRegistry.Round",
        "components": [
          {
            "name": "asset",
            "type": "uint8",
            "internalType": "enum StreamsRoundRegistry.Asset"
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
            "name": "voidableAfter",
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
            "internalType": "enum StreamsRoundRegistry.Outcome"
          },
          {
            "name": "opening",
            "type": "tuple",
            "internalType": "struct IStreamsBoundaryOracle.Observation",
            "components": [
              {
                "name": "price",
                "type": "int192",
                "internalType": "int192"
              },
              {
                "name": "validFromTimestamp",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "observationsTimestamp",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "expiresAt",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "reportHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "decimals",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          },
          {
            "name": "closing",
            "type": "tuple",
            "internalType": "struct IStreamsBoundaryOracle.Observation",
            "components": [
              {
                "name": "price",
                "type": "int192",
                "internalType": "int192"
              },
              {
                "name": "validFromTimestamp",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "observationsTimestamp",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "expiresAt",
                "type": "uint32",
                "internalType": "uint32"
              },
              {
                "name": "reportHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "decimals",
                "type": "uint8",
                "internalType": "uint8"
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
        "internalType": "contract IStreamsObservationCache"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
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
    "name": "pendingOwner",
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
        "internalType": "enum StreamsRoundRegistry.Phase"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proxiableUUID",
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
    "name": "roundIdFor",
    "inputs": [
      {
        "name": "asset",
        "type": "uint8",
        "internalType": "enum StreamsRoundRegistry.Asset"
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
  },
  {
    "type": "function",
    "name": "voidGrace",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  }
] as const;

export const streamsOracleReadAbi = [
  {
    "type": "function",
    "name": "btcDecimals",
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
    "name": "destinationChainId",
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
    "name": "ethDecimals",
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
    "name": "getObservation",
    "inputs": [
      {
        "name": "feedId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "boundary",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IStreamsBoundaryOracle.Observation",
        "components": [
          {
            "name": "price",
            "type": "int192",
            "internalType": "int192"
          },
          {
            "name": "validFromTimestamp",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "observationsTimestamp",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "expiresAt",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "reportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minimumGasLimit",
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
    "name": "nativeMessenger",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract INativeOracleMessenger"
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
    "name": "publisher",
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
    "name": "routeHash",
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
    "name": "sourceChainId",
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
    "name": "sourceMessenger",
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
    "name": "sourceOracle",
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
    "name": "verifyBoundary",
    "inputs": [
      {
        "name": "feedId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "boundary",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxPublishTime",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "evidence",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "observation",
        "type": "tuple",
        "internalType": "struct IStreamsBoundaryOracle.Observation",
        "components": [
          {
            "name": "price",
            "type": "int192",
            "internalType": "int192"
          },
          {
            "name": "validFromTimestamp",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "observationsTimestamp",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "expiresAt",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "reportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "decimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
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
