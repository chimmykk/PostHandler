const { CID } = require('multiformats/cid');
const { base32 } = require('multiformats/bases/base32');
const { base58btc } = require('multiformats/bases/base58');

// The CID object from your input
const cidObject = {
  "lastRootCID": {
    "code": 112,
    "version": 1,
    "hash": {
            "0": 18,
            "1": 32,
            "2": 114,
            "3": 163,
            "4": 0,
            "5": 54,
            "6": 177,
            "7": 32,
            "8": 56,
            "9": 176,
            "10": 19,
            "11": 99,
            "12": 81,
            "13": 189,
            "14": 160,
            "15": 46,
            "16": 210,
            "17": 204,
            "18": 223,
            "19": 2,
            "20": 16,
            "21": 55,
            "22": 85,
            "23": 20,
            "24": 70,
            "25": 40,
            "26": 80,
            "27": 206,
            "28": 22,
            "29": 174,
            "30": 149,
            "31": 241,
            "32": 126,
            "33": 146
    }
  }
};

// Convert the hash object to Uint8Array
function hashObjectToUint8Array(hashObj) {
  // Get the length of the hash object
  const length = Object.keys(hashObj).length;
  
  // Create a new Uint8Array with the correct length
  const bytes = new Uint8Array(length);
  
  // Fill the array with values from the hash object
  for (let i = 0; i < length; i++) {
    bytes[i] = hashObj[i];
  }
  
  return bytes;
}

function decodeCID() {
  try {
    const { lastRootCID } = cidObject;
    const hashBytes = hashObjectToUint8Array(lastRootCID.hash);

    // Create the bytes for the full CID
    const version = lastRootCID.version;
    const codec = lastRootCID.code;
    
    // Create the CID bytes
    const cidBytes = new Uint8Array(hashBytes.length + 2);
    cidBytes[0] = version;
    cidBytes[1] = codec;
    cidBytes.set(hashBytes, 2);
    
    // Encode to base58btc
    const cidString = base58btc.encode(cidBytes);
    console.log('CID (base58btc):', cidString);
    
    // Also show base32 encoding
    const cidBase32 = base32.encode(cidBytes);
    console.log('CID (base32):', cidBase32);
    
    return {
      base58: cidString,
      base32: cidBase32
    };
  } catch (error) {
    console.error('Error decoding CID:', error);
    throw error;
  }
}

// Execute the decode function
try {
  const result = decodeCID();
  console.log('\nDecoding successful!');
  console.log('You can use either of these CID formats:');
  console.log('Base58:', result.base58);
  console.log('Base32:', result.base32);
} catch (error) {
  console.error('Failed to decode CID:', error);
}

module.exports = {
  decodeCID,
  hashObjectToUint8Array
};