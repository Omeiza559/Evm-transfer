import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  id,
  zeroPadValue,
} from "ethers";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function transfer(address to, uint amount) returns (bool)",
];

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

function formatTokenAmount(amount, decimals) {
  return formatUnits(amount, decimals);
}

async function monitorAndTransfer(networkConfig) {
  const { name, rpcUrl } = networkConfig;
  const privateKey = process.env.PRIVATE_KEY;
  const recipient = process.env.RECIPIENT_ADDRESS;
  const customTokensEnv = process.env.CUSTOM_TOKENS || "";

  const customTokenAddresses = customTokensEnv
    .split(",")
    .map((addr) => addr.trim().toLowerCase())
    .filter((addr) => addr.length === 42 && addr.startsWith("0x"));

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const senderAddress = (await wallet.getAddress()).toLowerCase();

    console.log(`
┌─ ${chalk.bold.cyan(name)} ${chalk.gray("─".repeat(45 - name.length))}─┐
│ ${chalk.white("Status")}:    ${chalk.green("Active")}
│ ${chalk.white("Wallet")}:    ${chalk.yellow(senderAddress)}
│ ${chalk.white("Recipient")}: ${chalk.blue(recipient)}
└${chalk.gray("─".repeat(55))}┘
`);

    const getTokenDetails = async (tokenAddress) => {
      try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider);
        const [symbol, decimals, name] = await Promise.all([
          tokenContract.symbol().catch(() => "UNKNOWN"),
          tokenContract.decimals().catch(() => 18),
          tokenContract.name
            ? tokenContract.name().catch(() => "Unknown Token")
            : "Unknown Token",
        ]);
        return { symbol, decimals, name };
      } catch {
        return { symbol: "UNKNOWN", decimals: 18, name: "Unknown Token" };
      }
    };

    const transferToken = async (tokenAddress, tokenDetails) => {
      try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, wallet);
        const balance = await tokenContract.balanceOf(senderAddress);

        if (balance === 0n || balance.toString() === "0") return false;

        const formattedBalance = formatTokenAmount(
          balance,
          tokenDetails.decimals
        );

        console.log(
          chalk.cyan(
            `[${name}] 🔄 Transferring ${formattedBalance} ${tokenDetails.symbol} (${tokenDetails.name})...`
          )
        );

        const tx = await tokenContract.transfer(recipient, balance);
        await tx.wait();

        console.log(
          chalk.green(
            `[${name}] ✅ Transferred ${formattedBalance} ${tokenDetails.symbol}!`
          )
        );
        console.log(chalk.gray(`   TxHash: ${tx.hash}\n`));

        return true;
      } catch (error) {
        console.log(
          chalk.red(
            `[${name}] ❌ Transfer failed for ${tokenDetails.symbol}: ${error.message}`
          )
        );
        return false;
      }
    };

    const processedTxs = new Set();

    const handleIncomingTransfer = async (log) => {
      const txHash = log.transactionHash;

      if (processedTxs.has(txHash)) return;
      processedTxs.add(txHash);

      const tokenAddress = log.address.toLowerCase();
      const tokenDetails = await getTokenDetails(tokenAddress);

      console.log(chalk.cyanBright(`[${name}] 📨 Incoming Transfer Detected!`));
      const transferInfo = `
    -> From Block: ${log.blockNumber}
    -> Token:      ${chalk.yellow(tokenDetails.symbol)} (${tokenDetails.name})
    -> Contract:   ${tokenAddress}
    -> TxHash:     ${log.transactionHash}
`;
      console.log(transferInfo);

      await new Promise((resolve) => setTimeout(resolve, 60000));
      await transferToken(tokenAddress, tokenDetails);
    };

    let lastCheckedBlock = await provider.getBlockNumber();
    console.log(
      chalk.gray(
        `[${name}] Monitoring for transfers from block ${lastCheckedBlock}...`
      )
    );

    setInterval(async () => {
      try {
        const currentBlock = await provider.getBlockNumber();
        if (currentBlock > lastCheckedBlock) {
          const filter = {
            address: undefined,
            topics: [TRANSFER_TOPIC, null, zeroPadValue(senderAddress, 32)],
          };
          const logs = await provider.getLogs({
            fromBlock: lastCheckedBlock + 1,
            toBlock: currentBlock,
            topics: filter.topics,
          });

          for (const log of logs) {
            await handleIncomingTransfer(log);
          }
          lastCheckedBlock = currentBlock;
        }
      } catch (error) {
        // Polling error suppressed
      }
    }, 15000);

    if (customTokenAddresses.length > 0) {
      console.log(
        chalk.blue(
          `[${name}] 🔍 Checking custom tokens for existing balances...`
        )
      );

      for (const tokenAddress of customTokenAddresses) {
        const tokenDetails = await getTokenDetails(tokenAddress);
        await transferToken(tokenAddress, tokenDetails);
      }
    }
  } catch (err) {
    if (
      err.code === "INVALID_ARGUMENT" &&
      err.message.includes("invalid BytesLike value")
    ) {
      console.error(chalk.red(`[${name}] Fatal Error: Invalid PRIVATE_KEY.`));
      console.error(
        chalk.red(
          `[${name}] Ensure PRIVATE_KEY is valid (no 0x prefix, 64 hex characters).`
        )
      );
    } else {
      console.error(chalk.red(`[${name}] Fatal error:`), err);
      console.log(chalk.yellow(`[${name}] 🔄 Restarting in 30 seconds...`));
      setTimeout(() => monitorAndTransfer(networkConfig), 30000);
    }
  }
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const recipient = process.env.RECIPIENT_ADDRESS;

  if (!privateKey || !recipient) {
    console.log(
      chalk.red(
        "❌ Missing environment variables PRIVATE_KEY or RECIPIENT_ADDRESS"
      )
    );
    process.exit(1);
  }

  const networkConfigs = [
    { name: "Ethereum", rpcUrl: process.env.RPC_URL },
    { name: "Arbitrum", rpcUrl: process.env.ARBITRUM_RPC_URL },
    { name: "Base", rpcUrl: process.env.BASE_RPC_URL },
    { name: "Polygon", rpcUrl: process.env.POLYGON_RPC_URL },
  ].filter((n) => n.rpcUrl);

  if (networkConfigs.length === 0) {
    console.log(
      chalk.red(
        "❌ No RPC URL configured. Please set at least one of: RPC_URL, ARBITRUM_RPC_URL, BASE_RPC_URL, POLYGON_RPC_URL"
      )
    );
    process.exit(1);
  }

  console.log(
    chalk.bold.cyan(`\n🤖 EVM Auto-Transfer Bot Initializing...`)
  );
  console.log(chalk.blue(`  Auto-transferring all tokens to: ${recipient}`));
  console.log(
    chalk.yellow(
      `  Monitoring ${networkConfigs.length} network(s): ${networkConfigs
        .map((n) => n.name)
        .join(", ")}\n`
    )
  );

  const promises = networkConfigs.map((config) => monitorAndTransfer(config));
  await Promise.all(promises);
}

main().catch((err) => {});
