import { ApiV3PoolInfoStandardItem, AmmV4Keys, AmmRpcData } from '@raydium-io/raydium-sdk-v2'
import { initSdk, txVersion, connection } from '../config'
import BN from 'bn.js'
import { isValidAmm } from './utils'
import Decimal from 'decimal.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { printSimulateInfo } from '../util'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

/**
 * Gets priority fee estimate from Helius API
 * @param transaction - Serialized transaction in Base58
 * @param priorityLevel - Priority level (Min, Low, Medium, High, VeryHigh, UnsafeMax)
 * @returns The estimated priority fee in microLamports
 */
async function getPriorityFeeEstimate(transaction: string, priorityLevel: string = 'Medium') {
  console.log(`Getting ${priorityLevel} priority fee estimate...`)
  
  try {
    // First try with all priority levels
    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getPriorityFeeEstimate',
        params: [
          {
            transaction,
            options: { 
              includeAllPriorityFeeLevels: true
            }
          }
        ]
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      console.error('Error getting priority fee:', data.error);
      return 10000; // Default fallback
    }
    
    if (data.result.priorityFeeLevels) {
      console.log('All priority fee levels:');
      console.log(JSON.stringify(data.result.priorityFeeLevels, null, 2));
      
      // Select the appropriate level
      let selectedFee;
      switch(priorityLevel) {
        case 'Min':
          selectedFee = data.result.priorityFeeLevels.min;
          break;
        case 'Low':
          selectedFee = data.result.priorityFeeLevels.low;
          break;
        case 'Medium':
          selectedFee = data.result.priorityFeeLevels.medium;
          break;
        case 'High':
          selectedFee = data.result.priorityFeeLevels.high;
          break;
        case 'VeryHigh':
          selectedFee = data.result.priorityFeeLevels.veryHigh;
          break;
        case 'UnsafeMax':
          selectedFee = data.result.priorityFeeLevels.unsafeMax;
          break;
        default:
          selectedFee = data.result.priorityFeeLevels.medium;
      }
      
      // Ensure minimum fee of 10000 microLamports
      selectedFee = Math.max(selectedFee, 10000);
      console.log(`Selected priority fee (${priorityLevel}):`, selectedFee);
      return selectedFee;
    } else if (data.result.priorityFeeEstimate) {
      // Ensure minimum fee of 10000 microLamports
      const fee = Math.max(data.result.priorityFeeEstimate, 10000);
      console.log(`Default priority fee:`, fee);
      return fee;
    }
    
    return 10000; // Default fallback
  } catch (error) {
    console.error('Error fetching priority fee:', error);
    return 10000; // Default fallback
  }
}

export const swap = async () => {
  const raydium = await initSdk()
  // Set amount to ~$0.25 USD worth of SOL (at $120 per SOL)
  const amountIn = 2_083_333 // ~0.00208 SOL, approximately $0.25 USD
  const inputMint = NATIVE_MINT.toBase58()
  const poolId = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2' // SOL-USDC pool

  let poolInfo: ApiV3PoolInfoStandardItem | undefined
  let poolKeys: AmmV4Keys | undefined
  let rpcData: AmmRpcData

  if (raydium.cluster === 'mainnet') {
    // note: api doesn't support get devnet pool info, so in devnet else we go rpc method
    // if you wish to get pool info from rpc, also can modify logic to go rpc method directly
    const data = await raydium.api.fetchPoolById({ ids: poolId })
    poolInfo = data[0] as ApiV3PoolInfoStandardItem
    if (!isValidAmm(poolInfo.programId)) throw new Error('target pool is not AMM pool')
    poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId)
    rpcData = await raydium.liquidity.getRpcPoolInfo(poolId)
  } else {
    // note: getPoolInfoFromRpc method only return required pool data for computing not all detail pool info
    const data = await raydium.liquidity.getPoolInfoFromRpc({ poolId })
    poolInfo = data.poolInfo
    poolKeys = data.poolKeys
    rpcData = data.poolRpcData
  }
  const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()]

  if (poolInfo.mintA.address !== inputMint && poolInfo.mintB.address !== inputMint)
    throw new Error('input mint does not match pool')

  const baseIn = inputMint === poolInfo.mintA.address
  const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA]

  const out = raydium.liquidity.computeAmountOut({
    poolInfo: {
      ...poolInfo,
      baseReserve,
      quoteReserve,
      status,
      version: 4,
    },
    amountIn: new BN(amountIn),
    mintIn: mintIn.address,
    mintOut: mintOut.address,
    slippage: 0.01, // range: 1 ~ 0.0001, means 100% ~ 0.01%
  })

  console.log(
    `computed swap ${new Decimal(amountIn)
      .div(10 ** mintIn.decimals)
      .toDecimalPlaces(mintIn.decimals)
      .toString()} ${mintIn.symbol || mintIn.address} to ${new Decimal(out.amountOut.toString())
      .div(10 ** mintOut.decimals)
      .toDecimalPlaces(mintOut.decimals)
      .toString()} ${mintOut.symbol || mintOut.address}, minimum amount out ${new Decimal(out.minAmountOut.toString())
      .div(10 ** mintOut.decimals)
      .toDecimalPlaces(mintOut.decimals)} ${mintOut.symbol || mintOut.address}`
  )

  // First create transaction without priority fee to get a serialized version for estimation
  const { transaction, execute } = await raydium.liquidity.swap({
    poolInfo,
    poolKeys,
    amountIn: new BN(amountIn),
    amountOut: out.minAmountOut, // out.amountOut means amount 'without' slippage
    fixedSide: 'in',
    inputMint: mintIn.address,
    txVersion,
  })

  // Serialize transaction for priority fee estimation
  const serializedTx = bs58.encode(transaction.serialize());
  
  // Get priority fee estimate from Helius API (using High priority)
  const priorityFee = await getPriorityFeeEstimate(serializedTx, 'High');
  
  // Create the transaction again but with the priority fee
  const { transaction: txWithPriorityFee, execute: executeWithPriorityFee } = await raydium.liquidity.swap({
    poolInfo,
    poolKeys,
    amountIn: new BN(amountIn),
    amountOut: out.minAmountOut,
    fixedSide: 'in',
    inputMint: mintIn.address,
    txVersion,

    // Set priority fee using the estimate
    computeBudgetConfig: {
      units: 600000,
      microLamports: priorityFee,
    },
  })

  printSimulateInfo()
  // don't want to wait confirm, set sendAndConfirm to false or don't pass any params to execute
  const { txId } = await executeWithPriorityFee({ sendAndConfirm: true })
  console.log(`swap successfully in amm pool:`, { txId: `https://explorer.solana.com/tx/${txId}` })

  process.exit() // if you don't want to end up node execution, comment this line
}

/** uncomment code below to execute */
swap()

/** The swap function now automatically uses the hot wallet from the default location:
 * /Volumes/LaCie/movies/billions/episode one/
 * 
 * It reads the hot-wallet-info.txt file to get the password and wallet file name,
 * then loads the wallet automatically.
 * 
 * Simply call:
 * swap()
 */