import axios from "axios";
import { Wallet, SecretNetworkClient, fromUtf8 } from "secretjs";
import fs from "fs";
import assert from "assert";

// Returns a client with which we can interact with secret network
const initializeClient = async (endpoint: string, chainId: string) => {
  const wallet = new Wallet(); // Use default constructor of wallet to generate random mnemonic.
  const accAddress = wallet.address;
  const client = await SecretNetworkClient.create({
    // Create a client to interact with the network
    grpcWebUrl: endpoint,
    chainId: chainId,
    wallet: wallet,
    walletAddress: accAddress,
  });

  console.log(`Initialized client with wallet address: ${accAddress}`);
  return client;
};

// Stores and instantiaties a new contract in our network
const initializeContract = async (
  client: SecretNetworkClient,
  contractPath: string,
  initMsg: object,
) => {
  const wasmCode = fs.readFileSync(contractPath);
  console.log("Uploading contract");

  const uploadReceipt = await client.tx.compute.storeCode(
    {
      wasmByteCode: wasmCode,
      sender: client.address,
      source: "",
      builder: "",
    },
    {
      gasLimit: 5000000,
    }
  );

  if (uploadReceipt.code !== 0) {
    console.log(
      `Failed to get code id: ${JSON.stringify(uploadReceipt.rawLog)}`
    );
    throw new Error(`Failed to upload contract`);
  }

  const codeIdKv = uploadReceipt.jsonLog![0].events[0].attributes.find(
    (a: any) => {
      return a.key === "code_id";
    }
  );

  const codeId = Number(codeIdKv!.value);
  console.log("Contract codeId: ", codeId);

  const contractCodeHash = await client.query.compute.codeHash(codeId);
  console.log(`Contract hash: ${contractCodeHash}`);

  const contract = await client.tx.compute.instantiateContract(
    {
      sender: client.address,
      codeId,
      initMsg: initMsg,
      codeHash: contractCodeHash,
      label: "My contract" + Math.ceil(Math.random() * 10000), // The label should be unique for every contract, add random string in order to maintain uniqueness
    },
    {
      gasLimit: 1000000,
    }
  );

  if (contract.code !== 0) {
    throw new Error(
      `Failed to instantiate the contract with the following error ${contract.rawLog}`
    );
  }

  const contractAddress = contract.arrayLog!.find(
    (log) => log.type === "message" && log.key === "contract_address"
  )!.value;

  console.log(`Contract address: ${contractAddress}`);

  var contractInfo: [string, string] = [contractCodeHash, contractAddress];
  return contractInfo;
};

const getFromFaucet = async (address: string) => {
  await axios.get(`http://localhost:5000/faucet?address=${address}`);
};

async function getScrtBalance(userCli: SecretNetworkClient): Promise<string> {
  let balanceResponse = await userCli.query.bank.balance({
    address: userCli.address,
    denom: "uscrt",
  });
  return balanceResponse.balance!.amount;
}

async function fillUpFromFaucet(
  client: SecretNetworkClient,
  targetBalance: Number
) {
  let balance = await getScrtBalance(client);
  while (Number(balance) < targetBalance) {
    try {
      await getFromFaucet(client.address);
    } catch (e) {
      console.error(`failed to get tokens from faucet: ${e}`);
    }
    balance = await getScrtBalance(client);
  }
  console.error(`got tokens from faucet: ${balance}`);
}

// Initialization procedure
async function initializeAndUploadContract() {
  let endpoint = "http://localhost:9091";
  let chainId = "secretdev-1";

  const client = await initializeClient(endpoint, chainId);

  await fillUpFromFaucet(client, 100_000_000);

  let initMsg1 = {
    name: "test_NFT",
    symbol: "token_symbol",
    entropy: "secret",
    config: {
      public_token_supply: false,
      public_owner: false,
      enable_sealed_metadata: false,
      unwrapped_metadata_is_private: true,
      minter_may_update_metadata: true,
      owner_may_update_metadata: false,
      enable_burn: true      
    },
  };

  const [nftContractHash, nftContractAddress] = await initializeContract(
    client,
    "wasm/snip721_upgradable.wasm",
    initMsg1,
  );

  let initMsg2 = {
    name: "test_NFT",
    symbol: "token_symbol",
    token_address: nftContractAddress,
    token_code_hash: nftContractHash,
  };

  const [providerContractHash, providerContractAddress] = await initializeContract(
    client,
    "wasm/metadata_provider.wasm",
    initMsg2,
  );

  var clientInfo: [SecretNetworkClient, string, string, string, string] = [
    client,
    nftContractHash,
    nftContractAddress,
    providerContractHash,
    providerContractAddress
  ];
  return clientInfo;
}

async function registerProvider(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string,
  providerContractHash: string,
  providerContractAddress: string,
) {
  const tx = await client.tx.compute.executeContract(
    {
      sender: client.address,
      contractAddress: contractAddress,
      codeHash: contractHash,
      msg: {
        register_metadata_provider: {
          address: providerContractAddress,
          code_hash: providerContractHash,
        },
      },
      sentFunds: [],
    },
    {
      gasLimit: 200000,
    }
  );


  let txLog = tx.arrayLog!.find((log) => log.key === "register_provider")!.value;
  console.log(`Registered Provider address is: ${txLog}`);

  let parsedTransactionData = JSON.parse(fromUtf8(tx.data[0]));
  console.log(parsedTransactionData);

  console.log(`Register Provider used ${tx.gasUsed} gas`);
}

async function mint(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string,
) {
  const tx = await client.tx.compute.executeContract(
    {
      sender: client.address,
      contractAddress: contractAddress,
      codeHash: contractHash,
      msg: {
        mint_nft: {
          token_id: "001",
          owner: client.address,
          public_metadata: { extension: {} },
          private_metadata: { extension: {} },
        },
      },
      sentFunds: [],
    },
    {
      gasLimit: 200000,
    }
  );

  let parsedTransactionData = JSON.parse(fromUtf8(tx.data[0]));
  console.log(parsedTransactionData);
  console.log(`Mint used ${tx.gasUsed} gas`);
}

async function queryCount(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string
): Promise<number> {
  type CountResponse = { count: number };

  const countResponse = (await client.query.compute.queryContract({
    contractAddress: contractAddress,
    codeHash: contractHash,
    query: { get_count: {} },
  })) as CountResponse;

  if ('err"' in countResponse) {
    throw new Error(
      `Query failed with the following err: ${JSON.stringify(countResponse)}`
    );
  }

  return countResponse.count;
}

async function incrementTx(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string
) {
  const tx = await client.tx.compute.executeContract(
    {
      sender: client.address,
      contractAddress: contractAddress,
      codeHash: contractHash,
      msg: {
        increment: {},
      },
      sentFunds: [],
    },
    {
      gasLimit: 200000,
    }
  );

  //let parsedTransactionData = JSON.parse(fromUtf8(tx.data[0])); // In our case we don't really need to access transaction data
  console.log(`Increment TX used ${tx.gasUsed} gas`);
}

// The following functions are only some examples of how to write integration tests, there are many tests that we might want to write here.
async function test_register_provider(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string,
  providerContractHash: string,
  providerContractAddress: string
) {
  await registerProvider(
    client,
    contractHash,
    contractAddress,
    providerContractHash,
    providerContractAddress,
  );
}

async function test_mint(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string,
) {
  await mint(
    client,
    contractHash,
    contractAddress,
  );
}

async function test_increment_stress(
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string
) {
  const onStartCounter: number = await queryCount(
    client,
    contractHash,
    contractAddress
  );

  let stressLoad: number = 10;
  for (let i = 0; i < stressLoad; ++i) {
    await incrementTx(client, contractHash, contractAddress);
  }

  const afterStressCounter: number = await queryCount(
    client,
    contractHash,
    contractAddress
  );
  assert(
    afterStressCounter - onStartCounter === stressLoad,
    `After running stress test the counter expected to be ${
      onStartCounter + 10
    } instead of ${afterStressCounter}`
  );
}

async function test_gas_limits() {
  // There is no accurate way to measure gas limits but it is actually very recommended to make sure that the gas that is used by a specific tx makes sense
}

async function runTestFunction(
  tester: (
    client: SecretNetworkClient,
    contractHash: string,
    contractAddress: string,
    providerContractHash: string,
    providerContractAddress: string,
  ) => void,
  client: SecretNetworkClient,
  contractHash: string,
  contractAddress: string,
  providerContractHash: string,
  providerContractAddress: string,
) {
  console.log(`Testing ${tester.name}`);
  await tester(client, contractHash, contractAddress, providerContractHash, providerContractAddress);
  console.log(`[SUCCESS] ${tester.name}`);
}

(async () => {
  const [client, nftContractHash, nftContractAddress, providerContractHash, providerContractAddress] =
    await initializeAndUploadContract();

  await runTestFunction(
    test_mint,
    client,
    nftContractHash,
    nftContractAddress,
    providerContractHash,
    providerContractAddress
  );
  await runTestFunction(
    test_register_provider,
    client,
    nftContractHash,
    nftContractAddress,
    providerContractHash,
    providerContractAddress
  );
  // await runTestFunction(
  //   test_set_metadata,
  //   client,
  //   nftContractHash,
  //   nftContractAddress,
  //   providerContractHash,
  //   providerContractAddress
  // );
  // await runTestFunction(
  //   test_query_metadata,
  //   client,
  //   nftContractHash,
  //   nftContractAddress,
  //   providerContractHash,
  //   providerContractAddress
  // );
  await runTestFunction(test_gas_limits, client, nftContractHash, nftContractAddress, providerContractHash, providerContractAddress);
})();
