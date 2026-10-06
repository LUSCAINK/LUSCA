// Fixtures for _evm.test.ts: real mainnet runtime bytecode (eth_getCode) and a trimmed Sourcify v2 record.
// WETH9 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 (solc 0.4.19, bzzr0 metadata trailer)
export const WETH9_CODE =
  '0x6060604052600436106100af576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806306fdde' +
  '03146100b9578063095ea7b31461014757806318160ddd146101a157806323b872dd146101ca5780632e1a7d4d14610243578063313ce56714610266' +
  '57806370a082311461029557806395d89b41146102e2578063a9059cbb14610370578063d0e30db0146103ca578063dd62ed3e146103d4575b6100b7' +
  '610440565b005b34156100c457600080fd5b6100cc6104dd565b60405180806020018281038252838181518152602001915080519060200190808383' +
  '60005b8381101561010c5780820151818401526020810190506100f1565b50505050905090810190601f168015610139578082038051600183602003' +
  '6101000a031916815260200191505b509250505060405180910390f35b341561015257600080fd5b610187600480803573ffffffffffffffffffffff' +
  'ffffffffffffffffff1690602001909190803590602001909190505061057b565b604051808215151515815260200191505060405180910390f35b34' +
  '156101ac57600080fd5b6101b461066d565b6040518082815260200191505060405180910390f35b34156101d557600080fd5b610229600480803573' +
  'ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff169060200190919080' +
  '3590602001909190505061068c565b604051808215151515815260200191505060405180910390f35b341561024e57600080fd5b6102646004808035' +
  '9060200190919050506109d9565b005b341561027157600080fd5b610279610b05565b604051808260ff1660ff168152602001915050604051809103' +
  '90f35b34156102a057600080fd5b6102cc600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610b18565b6040' +
  '518082815260200191505060405180910390f35b34156102ed57600080fd5b6102f5610b30565b604051808060200182810382528381815181526020' +
  '0191508051906020019080838360005b8381101561033557808201518184015260208101905061031a565b50505050905090810190601f1680156103' +
  '625780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b341561037b57600080fd5b6103b060048080' +
  '3573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610bce565b6040518082151515158152602001' +
  '91505060405180910390f35b6103d2610440565b005b34156103df57600080fd5b61042a600480803573ffffffffffffffffffffffffffffffffffff' +
  'ffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610be3565b604051808281526020019150' +
  '5060405180910390f35b34600360003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16' +
  '8152602001908152602001600020600082825401925050819055503373ffffffffffffffffffffffffffffffffffffffff167fe1fffcc4923d04b559' +
  'f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c346040518082815260200191505060405180910390a2565b60008054600181600116156101' +
  '000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004' +
  '80156105735780601f1061054857610100808354040283529160200191610573565b820191906000526020600020905b815481529060010190602001' +
  '80831161055657829003601f168201915b505050505081565b600081600460003373ffffffffffffffffffffffffffffffffffffffff1673ffffffff' +
  'ffffffffffffffffffffffffffffffff16815260200190815260200160002060008573ffffffffffffffffffffffffffffffffffffffff1673ffffff' +
  'ffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508273ffffffffffffffffffffffffffffffffffffffff1633' +
  '73ffffffffffffffffffffffffffffffffffffffff167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9258460405180' +
  '82815260200191505060405180910390a36001905092915050565b60003073ffffffffffffffffffffffffffffffffffffffff1631905090565b6000' +
  '81600360008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020' +
  '0160002054101515156106dc57600080fd5b3373ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffff' +
  'ffffff16141580156107b457507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff600460008673ffffffffffffffff' +
  'ffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffff' +
  'ffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205414155b156108cf5781' +
  '600460008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001' +
  '60002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020' +
  '01600020541015151561084457600080fd5b81600460008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffff' +
  'ffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffff' +
  'ffffffffffffffff168152602001908152602001600020600082825403925050819055505b81600360008673ffffffffffffffffffffffffffffffff' +
  'ffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008282540392505081905550816003600085' +
  '73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000' +
  '82825401925050819055508273ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffffffffff167fddf2' +
  '52ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040518082815260200191505060405180910390a36001905093925050' +
  '50565b80600360003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081' +
  '526020016000205410151515610a2757600080fd5b80600360003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffff' +
  'ffffffffffffffffffff168152602001908152602001600020600082825403925050819055503373ffffffffffffffffffffffffffffffffffffffff' +
  '166108fc829081150290604051600060405180830381858888f193505050501515610ab457600080fd5b3373ffffffffffffffffffffffffffffffff' +
  'ffffffff167f7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65826040518082815260200191505060405180910390a2' +
  '50565b600260009054906101000a900460ff1681565b60036020528060005260406000206000915090505481565b6001805460018160011615610100' +
  '0203166002900480601f0160208091040260200160405190810160405280929190818152602001828054600181600116156101000203166002900480' +
  '15610bc65780601f10610b9b57610100808354040283529160200191610bc6565b820191906000526020600020905b81548152906001019060200180' +
  '8311610ba957829003601f168201915b505050505081565b6000610bdb33848461068c565b905092915050565b600460205281600052604060002060' +
  '20528060005260406000206000915091505054815600a165627a7a72305820deb4c2ccab3c2fdca32ab3f46728389c2fe2c165d5fafa07661e4e004f' +
  '6c344a0029'

// Aave v3 Pool proxy 0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2 (EIP-1967 InitializableImmutableAdminUpgradeabilityProxy, solc 0.8.10, ipfs+solc trailer)
export const AAVE_POOL_PROXY_CODE =
  '0x60806040526004361061005a5760003560e01c80635c60da1b116100435780635c60da1b14610097578063d1f57894146100d5578063f851a44014' +
  '6100e85761005a565b80633659cfe6146100645780634f1ef28614610084575b6100626100fd565b005b34801561007057600080fd5b506100626100' +
  '7f3660046106be565b610137565b6100626100923660046106e0565b610189565b3480156100a357600080fd5b506100ac61025a565b60405173ffff' +
  'ffffffffffffffffffffffffffffffffffff909116815260200160405180910390f35b6100626100e3366004610792565b6102cb565b3480156100f4' +
  '57600080fd5b506100ac6103f7565b61010561045c565b6101356101307f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d38' +
  '2bbc5490565b610464565b565b3373ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000002f39d218133afab8f2b819b1' +
  '066c7e434ad94e9e1614156101815761017e81610488565b50565b61017e6100fd565b3373ffffffffffffffffffffffffffffffffffffffff7f0000' +
  '000000000000000000002f39d218133afab8f2b819b1066c7e434ad94e9e16141561024d576101d083610488565b60008373ffffffffffffffffffff' +
  'ffffffffffffffffffff1683836040516101f9929190610872565b600060405180830381855af49150503d8060008114610234576040519150601f19' +
  '603f3d011682016040523d82523d6000602084013e610239565b606091505b505090508061024757600080fd5b50505050565b6102556100fd565b50' +
  '5050565b60003373ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000002f39d218133afab8f2b819b1066c7e434ad94e' +
  '9e1614156102c057507f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5490565b6102c86100fd565b90565b600061' +
  '02f57f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5490565b73ffffffffffffffffffffffffffffffffffffffff' +
  '161461031557600080fd5b61034060017f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd610882565b7f360894a13b' +
  'a1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc1461036e5761036e6108c0565b610377826104d5565b8051156103f35760008273' +
  'ffffffffffffffffffffffffffffffffffffffff16826040516103a591906108ef565b600060405180830381855af49150503d80600081146103e057' +
  '6040519150601f19603f3d011682016040523d82523d6000602084013e6103e5565b606091505b505090508061025557600080fd5b5050565b600033' +
  '73ffffffffffffffffffffffffffffffffffffffff7f0000000000000000000000002f39d218133afab8f2b819b1066c7e434ad94e9e1614156102c0' +
  '57507f0000000000000000000000002f39d218133afab8f2b819b1066c7e434ad94e9e90565b610135610593565b3660008037600080366000845af4' +
  '3d6000803e808015610483573d6000f35b3d6000fd5b610491816104d5565b60405173ffffffffffffffffffffffffffffffffffffffff8216907fbc' +
  '7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b90600090a250565b6104de81610659565b61056f576040517f08c379a0' +
  '00000000000000000000000000000000000000000000000000000000815260206004820152603b60248201527f43616e6e6f74207365742061207072' +
  '6f787920696d706c656d656e746174696f60448201527f6e20746f2061206e6f6e2d636f6e7472616374206164647265737300000000006064820152' +
  '6084015b60405180910390fd5b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc55565b3373ffffffffffffffffff' +
  'ffffffffffffffffffffff7f0000000000000000000000002f39d218133afab8f2b819b1066c7e434ad94e9e161415610135576040517f08c379a000' +
  '000000000000000000000000000000000000000000000000000000815260206004820152603260248201527f43616e6e6f742063616c6c2066616c6c' +
  '6261636b2066756e6374696f6e20667260448201527f6f6d207468652070726f78792061646d696e0000000000000000000000000000606482015260' +
  '8401610566565b6000813f7fc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a47081811480159061068d57508115155b94' +
  '9350505050565b803573ffffffffffffffffffffffffffffffffffffffff811681146106b957600080fd5b919050565b6000602082840312156106d0' +
  '57600080fd5b6106d982610695565b9392505050565b6000806000604084860312156106f557600080fd5b6106fe84610695565b9250602084013567' +
  'ffffffffffffffff8082111561071b57600080fd5b818601915086601f83011261072f57600080fd5b81358181111561073e57600080fd5b87602082' +
  '850101111561075057600080fd5b6020830194508093505050509250925092565b7f4e487b7100000000000000000000000000000000000000000000' +
  '000000000000600052604160045260246000fd5b600080604083850312156107a557600080fd5b6107ae83610695565b9150602083013567ffffffff' +
  'ffffffff808211156107cb57600080fd5b818501915085601f8301126107df57600080fd5b8135818111156107f1576107f1610763565b604051601f' +
  '82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0908116603f0116810190838211818310171561083757610837' +
  '610763565b8160405282815288602084870101111561085057600080fd5b826020860160208301376000602084830101528095505050505050925092' +
  '9050565b8183823760009101908152919050565b6000828210156108bb577f4e487b7100000000000000000000000000000000000000000000000000' +
  '000000600052601160045260246000fd5b500390565b7f4e487b71000000000000000000000000000000000000000000000000000000006000526001' +
  '60045260246000fd5b6000825160005b8181101561091057602081860181015185830152016108f6565b8181111561091f576000828501525b509190' +
  '91019291505056fea2646970667358221220f1a1ebca2f78efacc19ba2648500988371e4d1b4f18add3683f91f74a0e968a464736f6c634300080a00' +
  '33'

// Sourcify v2 record of WETH9 (fields=sources,sourceIds,abi,compilation,proxyResolution,deployment), GPL text trimmed.
export const WETH9_SOURCIFY = {
 "sources": {
  "WETH9.sol": {
   "content": "// Copyright (C) 2015, 2016, 2017 Dapphub\r\n\r\n// This program is free software: you can redistribute it and/or modify\r\n// it under the terms of the GNU General Public License as published by\r\n// the Free Software Foundation, either version 3 of the License, or\r\n// (at your option) any later version.\r\n\r\n// This program is distributed in the hope that it will be useful,\r\n// but WITHOUT ANY WARRANTY; without even the implied warranty of\r\n// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the\r\n// GNU General Public License for more details.\r\n\r\n// You should have received a copy of the GNU General Public License\r\n// along with this program.  If not, see <http://www.gnu.org/licenses/>.\r\n\r\npragma solidity ^0.4.18;\r\n\r\ncontract WETH9 {\r\n    string public name     = \"Wrapped Ether\";\r\n    string public symbol   = \"WETH\";\r\n    uint8  public decimals = 18;\r\n\r\n    event  Approval(address indexed src, address indexed guy, uint wad);\r\n    event  Transfer(address indexed src, address indexed dst, uint wad);\r\n    event  Deposit(address indexed dst, uint wad);\r\n    event  Withdrawal(address indexed src, uint wad);\r\n\r\n    mapping (address => uint)                       public  balanceOf;\r\n    mapping (address => mapping (address => uint))  public  allowance;\r\n\r\n    function() public payable {\r\n        deposit();\r\n    }\r\n    function deposit() public payable {\r\n        balanceOf[msg.sender] += msg.value;\r\n        Deposit(msg.sender, msg.value);\r\n    }\r\n    function withdraw(uint wad) public {\r\n        require(balanceOf[msg.sender] >= wad);\r\n        balanceOf[msg.sender] -= wad;\r\n        msg.sender.transfer(wad);\r\n        Withdrawal(msg.sender, wad);\r\n    }\r\n\r\n    function totalSupply() public view returns (uint) {\r\n        return this.balance;\r\n    }\r\n\r\n    function approve(address guy, uint wad) public returns (bool) {\r\n        allowance[msg.sender][guy] = wad;\r\n        Approval(msg.sender, guy, wad);\r\n        return true;\r\n    }\r\n\r\n    function transfer(address dst, uint wad) public returns (bool) {\r\n        return transferFrom(msg.sender, dst, wad);\r\n    }\r\n\r\n    function transferFrom(address src, address dst, uint wad)\r\n        public\r\n        returns (bool)\r\n    {\r\n        require(balanceOf[src] >= wad);\r\n\r\n        if (src != msg.sender && allowance[src][msg.sender] != uint(-1)) {\r\n            require(allowance[src][msg.sender] >= wad);\r\n            allowance[src][msg.sender] -= wad;\r\n        }\r\n\r\n        balanceOf[src] -= wad;\r\n        balanceOf[dst] += wad;\r\n\r\n        Transfer(src, dst, wad);\r\n\r\n        return true;\r\n    }\r\n}\n"
  }
 },
 "sourceIds": {
  "WETH9.sol": {
   "id": 0
  }
 },
 "abi": [
  {
   "name": "name",
   "type": "function",
   "inputs": [],
   "outputs": [
    {
     "name": "",
     "type": "string"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "name": "approve",
   "type": "function",
   "inputs": [
    {
     "name": "guy",
     "type": "address"
    },
    {
     "name": "wad",
     "type": "uint256"
    }
   ],
   "outputs": [
    {
     "name": "",
     "type": "bool"
    }
   ],
   "payable": false,
   "constant": false,
   "stateMutability": "nonpayable"
  },
  {
   "name": "totalSupply",
   "type": "function",
   "inputs": [],
   "outputs": [
    {
     "name": "",
     "type": "uint256"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "name": "transferFrom",
   "type": "function",
   "inputs": [
    {
     "name": "src",
     "type": "address"
    },
    {
     "name": "dst",
     "type": "address"
    },
    {
     "name": "wad",
     "type": "uint256"
    }
   ],
   "outputs": [
    {
     "name": "",
     "type": "bool"
    }
   ],
   "payable": false,
   "constant": false,
   "stateMutability": "nonpayable"
  },
  {
   "name": "withdraw",
   "type": "function",
   "inputs": [
    {
     "name": "wad",
     "type": "uint256"
    }
   ],
   "outputs": [],
   "payable": false,
   "constant": false,
   "stateMutability": "nonpayable"
  },
  {
   "name": "decimals",
   "type": "function",
   "inputs": [],
   "outputs": [
    {
     "name": "",
     "type": "uint8"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "name": "balanceOf",
   "type": "function",
   "inputs": [
    {
     "name": "",
     "type": "address"
    }
   ],
   "outputs": [
    {
     "name": "",
     "type": "uint256"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "name": "symbol",
   "type": "function",
   "inputs": [],
   "outputs": [
    {
     "name": "",
     "type": "string"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "name": "transfer",
   "type": "function",
   "inputs": [
    {
     "name": "dst",
     "type": "address"
    },
    {
     "name": "wad",
     "type": "uint256"
    }
   ],
   "outputs": [
    {
     "name": "",
     "type": "bool"
    }
   ],
   "payable": false,
   "constant": false,
   "stateMutability": "nonpayable"
  },
  {
   "name": "deposit",
   "type": "function",
   "inputs": [],
   "outputs": [],
   "payable": true,
   "constant": false,
   "stateMutability": "payable"
  },
  {
   "name": "allowance",
   "type": "function",
   "inputs": [
    {
     "name": "",
     "type": "address"
    },
    {
     "name": "",
     "type": "address"
    }
   ],
   "outputs": [
    {
     "name": "",
     "type": "uint256"
    }
   ],
   "payable": false,
   "constant": true,
   "stateMutability": "view"
  },
  {
   "type": "fallback",
   "payable": true,
   "stateMutability": "payable"
  },
  {
   "name": "Approval",
   "type": "event",
   "inputs": [
    {
     "name": "src",
     "type": "address",
     "indexed": true
    },
    {
     "name": "guy",
     "type": "address",
     "indexed": true
    },
    {
     "name": "wad",
     "type": "uint256",
     "indexed": false
    }
   ],
   "anonymous": false
  },
  {
   "name": "Transfer",
   "type": "event",
   "inputs": [
    {
     "name": "src",
     "type": "address",
     "indexed": true
    },
    {
     "name": "dst",
     "type": "address",
     "indexed": true
    },
    {
     "name": "wad",
     "type": "uint256",
     "indexed": false
    }
   ],
   "anonymous": false
  },
  {
   "name": "Deposit",
   "type": "event",
   "inputs": [
    {
     "name": "dst",
     "type": "address",
     "indexed": true
    },
    {
     "name": "wad",
     "type": "uint256",
     "indexed": false
    }
   ],
   "anonymous": false
  },
  {
   "name": "Withdrawal",
   "type": "event",
   "inputs": [
    {
     "name": "src",
     "type": "address",
     "indexed": true
    },
    {
     "name": "wad",
     "type": "uint256",
     "indexed": false
    }
   ],
   "anonymous": false
  }
 ],
 "compilation": {
  "language": "Solidity",
  "compiler": "solc",
  "compilerVersion": "0.4.19+commit.c4cbbb05",
  "compilerSettings": {
   "libraries": {},
   "optimizer": {
    "runs": 200,
    "enabled": false
   },
   "remappings": []
  },
  "name": "WETH9",
  "fullyQualifiedName": "WETH9.sol:WETH9"
 },
 "proxyResolution": {
  "isProxy": false,
  "proxyType": null,
  "implementations": []
 },
 "deployment": {
  "blockNumber": "4719568"
 },
 "matchId": "1605500",
 "creationMatch": "match",
 "runtimeMatch": "match",
 "verifiedAt": "2024-08-08T13:28:37Z",
 "match": "match",
 "chainId": "1",
 "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
}
