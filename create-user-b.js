const { Account, RpcProvider, Contract, stark, cairo, hash, num } = require('starknet');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// StarkNet configuration
const STARKNET_RPC_URL = 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7';

// Contract addresses
const deployedAddresses = JSON.parse(fs.readFileSync(path.join(__dirname, '../../deployed-starknet-addresses.json'), 'utf8'));
const HTLC_CONTRACT_ADDRESS = deployedAddresses.htlcContract;
const STRK_TOKEN_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

// User B configuration
const USER_B_PRIVATE_KEY = process.env.STARKNET_PRIVATE_KEY;
const USER_B_ADDRESS = process.env.STARKNET_ADDRESS;

if (!USER_B_PRIVATE_KEY || !USER_B_ADDRESS) {
  console.error('❌ Error: STARKNET_PRIVATE_KEY and STARKNET_ADDRESS must be set in .env file');
  console.log('\n📝 To set up User B, please:');
  console.log('1. Create a .env file in the atomicX-backend directory');
  console.log('2. Add your Starknet private key and address:');
  console.log('   STARKNET_PRIVATE_KEY=0x_your_private_key_here');
  console.log('   STARKNET_ADDRESS=0x_your_address_here');
  console.log('3. Run this script again');
  process.exit(1);
}

// ERC20 ABI for token interactions
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'felt' }],
    outputs: [{ name: 'balance', type: 'Uint256' }],
    stateMutability: 'view'
  },
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'felt' },
      { name: 'amount', type: 'Uint256' }
    ],
    outputs: [{ name: 'success', type: 'felt' }]
  }
];

// HTLC Contract ABI
const HTLC_ABI = [
  {
    name: 'create_htlc',
    type: 'function',
    inputs: [
      { name: 'hashlock', type: 'felt' },
      { name: 'recipient', type: 'felt' },
      { name: 'token', type: 'felt' },
      { name: 'amount', type: 'Uint256' },
      { name: 'timelock', type: 'felt' }
    ],
    outputs: [{ name: 'htlc_id', type: 'felt' }]
  }
];

async function createUserBAndDeposit() {
  try {
    console.log('🚀 Creating User B and depositing 2.6 STRK tokens...\n');
    
    // Initialize StarkNet provider
    const provider = new RpcProvider({ 
      nodeUrl: STARKNET_RPC_URL
    });
    console.log(`✅ Connected to StarkNet Sepolia`);
    
    // Create User B account - version "1" for Cairo 1 contracts
    const userBAccount = new Account(provider, USER_B_ADDRESS, USER_B_PRIVATE_KEY, "1");
    console.log(`✅ User B account loaded: ${USER_B_ADDRESS}`);
    
    // Check account deployment and nonce
    try {
      const nonce = await userBAccount.getNonce();
      console.log(`📊 Account nonce: ${nonce}`);
    } catch (error) {
      console.error('❌ Account might not be deployed. Deploy it first or check the address.');
      return;
    }
    
    // Initialize STRK token contract
    const strkContract = new Contract(ERC20_ABI, STRK_TOKEN_ADDRESS, provider);
    strkContract.connect(userBAccount); // Connect account for transactions
    
    // Check User B's STRK balance
    console.log('\n💰 Checking User B STRK balance...');
    try {
      const balanceResult = await strkContract.balanceOf(USER_B_ADDRESS);
      // Convert uint256 to readable format
      const balanceBN = cairo.uint256ToBN(balanceResult.balance);
      const balanceInEther = Number(balanceBN) / 1e18; // STRK has 18 decimals
      console.log(`📊 User B STRK balance: ${balanceInEther.toFixed(4)} STRK`);
      
      if (balanceInEther < 2.6) {
        console.error('❌ Insufficient STRK balance. User B needs at least 2.6 STRK tokens.');
        console.log('💡 Get testnet STRK from a faucet or DEX');
        return;
      }
    } catch (error) {
      console.error('⚠️  Error checking STRK balance:', error.message);
      return;
    }
    
    // Generate hashlock
    console.log('\n🔐 Generating hashlock for HTLC...');
    const crypto = require('crypto');
    const secret = crypto.randomBytes(32).toString('hex');
    const secretBytes = Buffer.from(secret, 'hex');
    // Use StarkNet hashing for consistency
    const hashlock = hash.computeHashOnElements([cairo.felt(secret)]);
    const hashlockHex = '0x' + hashlock.toString(16);
    
    console.log(`🔑 Secret: 0x${secret}`);
    console.log(`🔒 Hashlock: ${hashlockHex}`);
    
    // Set up HTLC parameters
    const recipientAddress = USER_B_ADDRESS; // For demo, User B is both sender and recipient
    const amountInStrk = 2.6; // Changed from 260 to 2.6
    // Convert 2.6 STRK to wei (2.6 * 10^18)
    const amountInWei = cairo.uint256(BigInt(Math.floor(amountInStrk * 1e18)));
    const timelock = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    
    console.log('\n📋 HTLC Parameters:');
    console.log(`   Sender: ${USER_B_ADDRESS}`);
    console.log(`   Recipient: ${recipientAddress}`);
    console.log(`   Token: ${STRK_TOKEN_ADDRESS}`);
    console.log(`   Amount: ${amountInStrk} STRK`);
    console.log(`   Amount (wei): ${amountInWei.low.toString()}`);
    console.log(`   Timelock: ${timelock} (${new Date(timelock * 1000).toISOString()})`);
    
    // First, approve the HTLC contract to spend STRK tokens
    console.log('\n🔄 Approving HTLC contract to spend STRK tokens...');
    const approveTx = await strkContract.approve(
      HTLC_CONTRACT_ADDRESS,
      amountInWei
    );
    console.log(`📝 Approval transaction: ${approveTx.transaction_hash}`);
    await provider.waitForTransaction(approveTx.transaction_hash);
    console.log('✅ Approval confirmed');
    
    // Create HTLC
    console.log('\n🔄 Creating HTLC on StarkNet...');
    console.log(`📋 HTLC Contract Address: ${HTLC_CONTRACT_ADDRESS}`);
    
    // Initialize HTLC contract
    const htlcContract = new Contract(HTLC_ABI, HTLC_CONTRACT_ADDRESS, provider);
    htlcContract.connect(userBAccount);
    
    // Call create_htlc
    const createTx = await htlcContract.create_htlc(
      hashlockHex,        // hashlock
      recipientAddress,   // recipient
      STRK_TOKEN_ADDRESS, // token
      amountInWei,        // amount (uint256)
      cairo.felt(timelock.toString()) // timelock
    );
    
    console.log(`✅ HTLC creation transaction sent: ${createTx.transaction_hash}`);
    
    // Wait for transaction confirmation
    console.log('⏳ Waiting for transaction confirmation...');
    const receipt = await provider.waitForTransaction(createTx.transaction_hash);
    console.log(`✅ Transaction confirmed! Status: ${receipt.status}`);
    
    // Extract HTLC ID from events
    let htlcId = null;
    if (receipt.events && receipt.events.length > 0) {
      // Look for the HTLCCreated event
      for (const event of receipt.events) {
        // The first event data field often contains the HTLC ID
        if (event.data && event.data.length > 0) {
          htlcId = event.data[0];
          break;
        }
      }
    }
    
    // If no HTLC ID found in events, use transaction hash as ID
    if (!htlcId) {
      htlcId = createTx.transaction_hash;
    }
    
    console.log(`🆔 HTLC ID: ${htlcId}`);
    
    console.log('\n🎉 User B successfully created HTLC and deposited 2.6 STRK tokens!');
    console.log('\n📊 Transaction Summary:');
    console.log(`   Transaction Hash: ${createTx.transaction_hash}`);
    console.log(`   HTLC Contract: ${HTLC_CONTRACT_ADDRESS}`);
    console.log(`   HTLC ID: ${htlcId}`);
    console.log(`   Amount: ${amountInStrk} STRK`);
    console.log(`   Hashlock: ${hashlockHex}`);
    console.log(`   Secret: 0x${secret}`);
    console.log(`   Timelock: ${new Date(timelock * 1000).toISOString()}`);
    
    // Save transaction details
    const txDetails = {
      user: 'User B',
      address: USER_B_ADDRESS,
      transactionHash: createTx.transaction_hash,
      htlcContract: HTLC_CONTRACT_ADDRESS,
      htlcId: htlcId,
      amount: amountInStrk,
      amountWei: amountInWei.low.toString(),
      token: STRK_TOKEN_ADDRESS,
      hashlock: hashlockHex,
      secret: '0x' + secret,
      timelock: timelock,
      recipient: recipientAddress,
      createdAt: new Date().toISOString()
    };
    
    fs.writeFileSync(
      path.join(__dirname, '../../user-b-deposit.json'),
      JSON.stringify(txDetails, null, 2)
    );
    
    console.log('\n💾 Transaction details saved to: user-b-deposit.json');
    console.log('\n📝 Next steps:');
    console.log('1. Share the hashlock with the counterparty');
    console.log('2. Wait for their matching HTLC');
    console.log('3. Use the secret to withdraw their funds');
    
  } catch (error) {
    console.error('\n❌ Error creating HTLC:', error);
    
    if (error.message?.includes('Invalid transaction')) {
      console.log('\n💡 Possible solutions:');
      console.log('- Check if the account has enough ETH for gas fees');
      console.log('- Verify the contract addresses are correct');
      console.log('- Ensure the account is properly deployed');
    } else if (error.message?.includes('Insufficient allowance')) {
      console.log('\n💡 The HTLC contract needs approval to spend your STRK tokens');
    } else if (error.message?.includes('argent')) {
      console.log('\n💡 Make sure you\'re using the correct account implementation');
    }
  }
}

// Run the script
if (require.main === module) {
  createUserBAndDeposit();
}

module.exports = { createUserBAndDeposit };