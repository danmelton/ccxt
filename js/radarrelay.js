'use strict';

const Exchange = require ('./base/Exchange');
const { ExchangeError } = require ('./base/errors');

const { ZeroEx } = require ('0x.js');
const { HttpClient } = require ('@0xproject/connect');
const { BigNumber } = require ('@0xproject/utils');
const Web3 = require ('web3');

module.exports = class radarrelay extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'radarrelay',
            'name': 'Radar Relay',
            'countries': 'USA',
            'version': undefined,
            'userAgent': undefined,
            'rateLimit': 2000,
            'urls': {
                'logo': 'https://radarrelay.com/img/radar-logo-beta.svg',
                'api': 'https://api.radarrelay.com/0x/v0/',
                'www': 'https://radarrelay.com',
                'doc': [
                    'https://radarrelay.com/standard-relayer-api/',
                ],
            },
            'has': {
                'cancelInstantTransaction': false,
                'createOrder': false,
                'createMarketOrder': false,
                'createLimitOrder': false,
                'fetchBalance': false,
                'fetchCurrencies': true,
                'fetchL2OrderBook': false,
                'fetchMarkets': true,
                'fetchTicker': true,
                'fetchTrades': false,
                'privateAPI': false,
                'startInstantTransaction': false,
            },
            'api': {
                'public': {
                    'get': [
                        'token_pairs',
                        // 'getcoins',
                        // 'limit/{pair}',
                        // 'marketinfo/{pair}',
                        // 'rate/{pair}',
                        // 'recenttx/{max}',
                        // 'txStat/{address}',
                    ],
                    'post': [
                        'cancelpending',
                        'shift',
                    ],
                },
            },
            'requiredCredentials': {
                'apiKey': false,
                'secret': false,
            },
        });
    }

    // TODO:
    client () {
        if (!this.zeroXClient) {
            this.zeroXClient = new HttpClient (this.describe ()['urls']['api']);
        }
        return this.zeroXClient;
    }

    provider () {
        if (!this.zeroExNetwork) {
            const provider = new Web3.providers.HttpProvider ('https://mainnet.infura.io/krrAJZmXlhalDHthEiOR');
            this.zeroXNetwork = new ZeroEx (provider, {
                'networkId': 1,
            });
        }
        return this.zeroXNetwork;
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        const request = '/' + this.implodeParams (path, params);
        const url = this.urls['api'] + request;
        if (method === 'POST') {
            headers = { 'Content-Type': 'application/json' };
            body = JSON.stringify (params);
        }
        return {
            'url': url,
            'method': method,
            'body': body,
            'headers': headers,
        };
    }

    async fetchCurrencies () {
        let tokens = null;
        try {
            tokens = await this.provider ().tokenRegistry.getTokensAsync ();
        } catch (e) {
            console.error (e);
            return;
        }
        const result = {};
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            result[token.symbol] = {
                'id': token.symbol,
                'code': token.symbol,
                'info': token,
                'name': token.name,
                'active': true,
                'status': 'ok',
                'precision': token.decimals,
            };
        }
        return result;
    }

    static sortOrders (bids) {
        return bids.sort ((orderA, orderB) => {
            const orderRateA = new BigNumber (orderA.makerTokenAmount).div (new BigNumber (orderA.takerTokenAmount));
            const orderRateB = new BigNumber (orderB.makerTokenAmount).div (new BigNumber (orderB.takerTokenAmount));
            return orderRateB.comparedTo (orderRateA);
        });
    }

    static calculateRates (orders, isBid, decimals) {
        const orderCount = orders.length;
        const rates = new Array (orderCount);
        const one = new BigNumber (1.0);
        for (let i = 0; i < orderCount; i++) {
            const order = orders[i];
            const { makerTokenAmount, takerTokenAmount } = order;
            const rate = isBid ?
                new BigNumber (makerTokenAmount).div (new BigNumber (takerTokenAmount)) :
                one.div (new BigNumber (makerTokenAmount).div (new BigNumber (takerTokenAmount)));
            const limit = ZeroEx.toUnitAmount (new BigNumber (takerTokenAmount), decimals);
            rates[i] = [rate.toString (), limit.toString (), order];
        }
        return rates;
    } // TODO: figure out the rules for the limit

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        await Promise.all ([this.loadMarkets (), this.fetchCurrencies ()]);
        const marketEntry = this.markets[symbol];
        const response = await this.client ().getOrderbookAsync ({
            'baseTokenAddress': marketEntry.info.tokenB.address, // ZRX, eg
            'quoteTokenAddress': marketEntry.info.tokenA.address, // WETH
        });
        const [baseSymbol, quoteSymbol] = symbol.split ('/');
        const baseDecimals = this.currencies[baseSymbol].precision;
        const quoteDecimals = this.currencies[quoteSymbol].precision;

        const { asks, bids } = response;
        const sortedBids = radarrelay.sortOrders (bids);
        const sortedAsks = radarrelay.sortOrders (asks);

        const bidRates = radarrelay.calculateRates (sortedBids, true, baseDecimals);
        const askRates = radarrelay.calculateRates (sortedAsks, false, quoteDecimals);
        return {
            'timestamp': new Date ().getTime (),
            'bids': bidRates,
            'asks': askRates,
            'info': response,
        };
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        const marketEntry = this.markets[symbol];
        let orderbookResponse = undefined;
        try {
            orderbookResponse = await this.client ().getOrderbookAsync ({
                'baseTokenAddress': marketEntry.info.tokenA.address,
                'quoteTokenAddress': marketEntry.info.tokenB.address,
            });
        } catch (e) {
            console.error (e);
            return;
        }
        const { asks, bids } = orderbookResponse;
        const [bestAsk, bestBid] = [asks[0], bids[0]];
        const ask = bestAsk.makerTokenAmount.div (bestAsk.takerTokenAmount).toNumber ();
        const bid = bestBid.makerTokenAmount.div (bestBid.takerTokenAmount).toNumber ();
        const now = new Date ();
        return {
            'symbol': symbol,
            'info': orderbookResponse,
            'timestamp': now.getTime (),
            'datetime': now.toISOString (),
            'bid': bid,
            'bidVolume': ZeroEx.toUnitAmount (bestBid.takerTokenAmount, marketEntry.info.tokenB.precision),
            'ask': ask,
            'askVolume': ZeroEx.toUnitAmount (bestAsk.takerTokenAmount, marketEntry.info.tokenA.precision),
        };
    }

    async fetchMarkets () {
        const marketsResponse = await this.client ().getTokenPairsAsync ({ 'page': 1, 'perPage': 500 });
        const numMarkets = marketsResponse.length;
        const result = [];
        for (let i = 0; i < numMarkets; i++) {
            const market = marketsResponse[i];
            const baseAddress = market.tokenA.address;
            const quoteAddress = market.tokenB.address;
            const base = radarrelay.addressLookup ()[baseAddress];
            const quote = radarrelay.addressLookup ()[quoteAddress];
            if (!base || !quote) continue;
            const aToBSymbol = `${base}/${quote}`;
            const aPrecision = market.tokenA.precision;
            result.push ({
                'id': aToBSymbol,
                'symbol': aToBSymbol,
                base,
                quote,
                'active': true,
                'precision': {
                    'price': aPrecision,
                    'amount': aPrecision,
                    'cost': aPrecision,
                },
                'limits': {
                    'amount': {
                        'min': market.tokenA.minAmount,
                        'max': market.tokenA.maxAmount,
                    },
                },
                'info': market,
            });
            const bToASymbol = `${quote}/${base}`;
            const bPrecision = market.tokenB.precision;
            result.push ({
                'id': bToASymbol,
                'symbol': bToASymbol,
                'base': quote,
                'quote': base,
                'active': true,
                'precision': {
                    'price': bPrecision,
                    'amount': bPrecision,
                    'cost': bPrecision,
                },
                'limits': {
                    'amount': {
                        'min': market.tokenB.minAmount,
                        'max': market.tokenB.maxAmount,
                    },
                },
                'info': market,
            });
        }
        return result;
    }

    static addressLookup () {
        return {
            '0x86fa049857e0209aa7d9e616f7eb3b3b78ecfdb0': 'EOS',
            '0xf230b790e05390fc8295f4d3f60332c93bed42e2': 'TRX',
            '0xd850942ef8811f2a866692a623011bde52a462c1': 'VEN',
            '0xd26114cd6EE289AccF82350c8d8487fedB8A0C07': 'OMG',
            '0xB8c77482e45F1F44dE1745F52C74426C631bDD52': 'BNB',
            '0xd4fa1460f537bb9085d22c7bccb5dd450ef28e3a': 'PPT',
            '0x744d70fdbe2ba4cf95131626614a1763df805b9e': 'SNT',
            '0x168296bb09e24a88805cb9c33356536b980d3fc5': 'RHOC',
            '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': 'MKR',
            '0xb7cb1c96db6b22b0d3d9536e0108d062bd488f74': 'WTC',
            '0x5ca9a71b1d01849c0a95490cc00559717fcf0d1d': 'AE',
            '0xe94327d07fc17907b4db788e5adf2ed424addff6': 'REP',
            '0xe41d2489571d322189246dafa5ebde1f4699f498': 'ZRX',
            '0xcb97e65f07da24d46bcdd078ebebd7c6e6e3d750': 'BTM',
            '0x8f3470A7388c05eE4e7AF3d01D8C722b0FF52374': 'VERI',
            '0xa74476443119A942dE498590Fe1f2454d7D4aC0d': 'GNT',
            '0x0d8775f648430679a709e98d2b0cb6250d2887ef': 'BAT',
            '0x419c4db4b9e25d6db2ad9691ccb832c8d9fda05e': 'DRGN',
            '0x5af2be193a6abca9c8817001f45744777db30756': 'ETHOS',
            '0x05f4a42e251f2d52b8ed15e9fedaacfcef1fad27': 'ZIL',
            '0x039b5649a59967e3e936d7471f9c3700100ee1ab': 'KCS',
            '0xbf2179859fc6D5BEE9Bf9158632Dc51678a4100e': 'ELF',
            '0x4CEdA7906a5Ed2179785Cd3A40A69ee8bc99C466': 'AION',
            '0x618e75ac90b12c6049ba3b27f5d5f8651b0037f6': 'QASH',
            '0x419d0d8bdd9af5e606ae2232ed285aff190e711b': 'FUN',
            '0x5d65d971895edc438f465c17db6992698a52318d': 'NAS',
            '0x48f775efbe4f5ece6e0df2f7b5932df56823b990': 'R',
            '0xdd974d5c2e2928dea5f71b9825b8b646686bd200': 'KNC',
            '0xfa1a856cfa3409cfa145fa4e20eb270df3eb21ab': 'IOST',
            '0x4156D3342D5c385a87D264F90653733592000581': 'SALT',
            '0x818fc6c2ec5986bc6e2cbf00939d90556ab12ce5': 'KIN',
            '0x3597bfd533a99c9aa083587b074434e61eb0a258': 'DENT',
            '0x595832f8fc6bf59c85c527fec3740a1b7a361269': 'POWR',
            '0x514910771af9ca656af840dff83e8264ecf986ca': 'LINK',
            '0x08d32b0da63e2C3bcF8019c9c5d849d7a9d791e6': '٨',
            '0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c': 'BNT',
            '0x888666CA69E0f178DED6D75b5726Cee99A87D698': 'ICN',
            '0xB97048628DB6B661D4C2aA833e95Dbe1A905B280': 'PAY',
            '0x9992ec3cf6a55b00978cddf2b27bc6882d88d1ec': 'POLY',
            '0xf0ee6b27b759c9893ce4f094b49ad28fd15a23e4': 'ENG',
            '0x8f8221afbb33998d8584a2b05749ba73c37a938a': 'REQ',
            '0xd4c435f5b09f855c3317c8524cb1f586e42795fa': 'CND',
            '0xe3818504c1b32bf1557b16c238b2e01fd3149c17': 'PLR',
            '0x8eb24319393716668d768dcec29356ae9cffe285': 'AGI',
            '0x68d57c9a1c35f63e2c83ee8e49a64e9d70528d25': 'SRN',
            '0xb64ef51c888972c908cfacf59b47c1afbc0ab8ac': 'STORJ',
            '0x6810e776880c02933d47db1b9fc05908e5386b96': 'GNO',
            '0x39Bb259F66E1C59d5ABEF88375979b4D20D98022': 'WAX',
            '0x960b236A07cf122663c4303350609A66A7B288C0': 'ANT',
            '0x103c3a209da59d3e7c4a89307e66521e081cfdf0': 'GVT',
            '0x255aa6df07540cb5d3d297f0d0d4d84cb52bc8e6': 'RDN',
            '0x99ea4db9ee77acd40b119bd1dc4e33e1c070b80d': 'QSP',
            '0xf629cbd94d3791c9250152bd8dfbdf380e2a3b9c': 'ENJ',
            '0xF433089366899D83a9f26A773D59ec7eCF30355e': 'MTL',
            '0x7c5a0ce9267ed19b22f8cae653f198e3e8daf098': 'SAN',
            '0x3883f5e181fccaF8410FA61e12b59BAd963fb645': 'THETA',
            '0x41e5560054824ea6b0732e656e3ad64e20e94e45': 'CVC',
            '0x0f5d2fb29fb7d3cfee444a200298f468908cc942': 'MANA',
            '0xd0a4b8946cb52f0661273bfbc6fd0e0c75fc6433': 'STORM',
            '0xb63b606ac810a52cca15e44bb630fd42d8d1d83d': 'MCO',
            '0x46b9ad944d1059450da1163511069c718f699d31': 'CS',
            '0x0e0989b1f9b8a38983c2ba8053269ca62ec9b195': 'POE',
            '0x90528aeb3a2b736b780fd1b6c478bb7e1d643170': 'XPA',
            '0x12480e24eb5bec1a9d4369cab6a80cad3c0a377a': 'SUB',
            '0xc42209aCcC14029c1012fB5680D95fBd6036E2a0': 'PPP',
            '0xd234bf2410a0009df9c3c63b610c09738f18ccd7': 'DTR',
            '0x607F4C5BB672230e8672085532f7e901544a7375': 'RLC',
            '0xb91318f35bdb262e9423bc7c7c2a3a93dd93c92c': 'NULS',
            '0xb98d4c97425d9908e66e53a6fdf673acca0be986': 'ABT',
            '0xf7920b0768ecb20a123fac32311d07d193381d6f': 'TNB',
            '0x66186008C1050627F979d464eABb258860563dbE': 'MDS',
            '0x3833dda0aeb6947b98ce454d89366cba8cc55528': 'SPHTX',
            '0x340d2bde5eb28c1eed91b2f790723e3b160613b7': 'VEE',
            '0x85e076361cc813a908ff672f9bad1541474402b2': 'TEL',
            '0x80fB784B7eD66730e8b1DBd9820aFD29931aab03': 'LEND',
            '0x4470bb87d77b963a013db939be332f927f2b992e': 'ADX',
            '0x2c4e8f2d746113d0696ce89b35f0d8bf88e0aeca': 'ST',
            '0x1844b21593262668b7248d0f57a220caaba46ab9': 'PRL',
            '0x5e6b6d9abad9093fdc861ea1600eba1b355cd940': 'ITC',
            '0x20e94867794dba030ee287f1406e100d03c84cd3': 'DEW',
            '0x26e75307fc0c021472feb8f727839531f112f317': 'C20',
            '0x5732046a883704404f284ce41ffadd5b007fd668': 'BLZ',
            '0x697beac28b09e122c4332d163985e8a73121b97f': 'QRL',
            '0xBEB9eF514a379B997e0798FDcC901Ee474B6D9A1': 'MLN',
            '0x08711d3b02c8758f2fb3ab4e80228418a7f8e39c': 'EDG',
            '0xf970b8e36e23f7fc3fd752eea86f8be8d83375a6': 'RCN',
            '0x4dc3643dbc642b72c158e7f3d2ff232df61cb6ce': 'AMB',
            '0x69b148395ce0015c13e36bffbad63f49ef874e03': 'DTA',
            '0xb3104b4b9da82025e8b9f8fb28b3553ce2f67069': 'BIX',
            '0xe8ff5c9c75deb346acac493c463c8950be03dfba': 'VIBE',
            '0xced4e93198734ddaff8492d525bd258d49eb388e': 'EDO',
            '0x983f6d60db79ea8ca4eb9968c6aff8cfa04b3c63': 'SNM',
            '0xa5fd1a791c4dfcaacc963d4f73c6ae5824149ea7': 'JNT',
            '0x42d6622dece394b54999fbd73d108123806f6a18': 'SPANK',
            '0x667088b212ce3d06a1b553a7221E1fD19000d9aF': 'WINGS',
            '0xf85feea2fdd81d51177f6b8f35f0e6734ce45f5f': 'CMT',
            '0x0cf0ee63788a0849fe5297f3407f701e122cc023': 'DATA',
            '0x1a7a8bd9106f2b8d977e08582dc7d24c723ab0db': 'APPC',
            '0xaec2e87e0a235266d9c5adc9deb4b2e29b54d009': 'SNGLS',
            '0x4CF488387F035FF08c371515562CBa712f9015d4': 'WPR',
            '0xb2f7eb1f2c37645be61d73953035360e768d81e6': 'COB',
            '0x27054b13b1b798b345b591a4d22e6562d47ea75a': 'AST',
            '0x70a72833d6bf7f508c8224ce59ea1ef3d0ea3a38': 'UTK',
            '0x558ec3152e2eb2174905cd19aea4e34a23de9ad6': 'BRD',
            '0x286bda1413a2df81731d4930ce2f862a35a609fe': 'WaBi',
            '0x5b2e4a700dfbc560061e957edec8f6eeeb74a320': 'INS',
            '0x40395044Ac3c0C57051906dA938B54BD6557F212': 'MGO',
            '0x6c2adc2073994fb2ccc5032cc2906fa221e9b391': 'DPY',
            '0xe7775a6e9bcf904eb39da2b68c5efb4f9360e08c': 'TAAS',
            '0xea38eaa3c86c8f9b751533ba2e562deb9acded40': 'FUEL',
            '0xc5bbae50781be1669306b9e001eff57a2957b09d': 'GTO',
            '0x554c20b7c486beee439277b4540a434566dc4c02': 'HST',
            '0xaa7a9ca87d3694b5755f213b5d04094b8d0f0a6f': 'TRAC',
            '0x0abdace70d3790235af448c88547603b945604ea': 'DNT',
            '0x72dd4b6bd852a3aa172be4d6c5a6dbec588cf131': 'NGC',
            '0x957c30ab0426e0c93cd8241e2c60392d08c6ac8e': 'MOD',
            '0xfae4ee59cdd86e3be9e8b90b53aa866327d7c090': 'CPC',
            '0x36905fc93280f52362a1cbab151f25dc46742fb5': 'BTO',
            '0x92e52a1a235d9a103d970901066ce910aacefd37': 'UCASH',
            '0xfa05A73FfE78ef8f1a739473e462c54bae6567D9': 'LUN',
            '0x1c4481750daa5ff521a2a7490d9981ed46465dbd': 'BCPT',
            '0x24692791bc444c5cd0b81e3cbcaba4b04acd1f3b': 'UKG',
            '0x08f5a9235b08173b7569f83645d2c7fb55e8ccd8': 'TNT',
            '0xd0d6d6c5fe4a677d343cc433536bb717bae167dd': 'ADT',
            '0x2fe6ab85ebbf7776fee46d191ee4cea322cecf51': 'CDT',
            '0x12fef5e57bf45873cd9b62e9dbd7bfb99e32d73e': 'CFI',
            '0x41dbecc1cdc5517c6f76f6a6e836adbee2754de3': 'MTN',
            '0x96A65609a7B84E8842732DEB08f56C3E21aC6f8a': 'Centra',
            '0x2c974b2d0ba1716e644c1fc59982a89ddd2ff724': 'VIB',
            '0x5136C98A80811C3f46bDda8B5c4555CFd9f812F0': 'IDH',
            '0xcbcc0f036ed4788f63fc0fee32873d6a7487b908': 'HMQ',
            '0xaaaf91d9b90df800df4f55c205fd6989c977e73a': 'TKN',
            '0x88a3e4f35d64aad41a6d4030ac9afe4356cb84fa': 'PRE',
            '0x80a7e048f37a50500351c204cb407766fa3bae7f': 'CRPT',
            '0x4092678e4E78230F46A1534C0fbc8fA39780892B': 'OCN',
            '0x27695e09149adc738a978e9a678f99e4c39e9eb9': 'KICK',
            '0x81c9151de0c8bafcd325a57e3db5a5df1cebf79c': 'DAT',
            '0x9B11EFcAAA1890f6eE52C6bB7CF8153aC5d74139': 'ATM',
            '0x65292eeadf1426cd2df1c4793a3d7519f253913b': 'COSS',
            '0xf3db5fa2c66b7af3eb0c0b782510816cbe4813b8': 'EVX',
            '0x12b306fa98f4cbb8d4457fdff3a0a0a56f07ccdf': 'SXDT',
            '0x1776e1f26f98b1a5df9cd347953a26dd3cb46671': 'NMR',
            '0x0b76544f6c413a555f309bf76260d1e02377c02a': 'INT',
            '0x327682779bab2bf4d1337e8974ab9de8275a7ca8': 'BPT',
            '0xcb94be6f13a1182e4a4b6140cb7bf2025d28e41b': 'TRST',
            '0xC0Eb85285d83217CD7c891702bcbC0FC401E2D9D': 'HVN',
            '0x9e88613418cf03dca54d6a2cf6ad934a78c7a17a': 'SWM',
            '0x04f2e7221fdb1b52a68169b25793e51478ff0329': 'CAPP',
            '0x2d0e95bd4795d7ace0da3c0ff7b706a5970eb9d3': 'SOC',
            '0x516e5436bafdc11083654de7bb9b95382d08d5de': 'ORME',
            '0xD65960FAcb8E4a2dFcb2C2212cb2e44a02e2a57E': 'Soar',
            '0xF4134146AF2d511Dd5EA8cDB1C4AC88C57D60404': 'SNC',
            '0x12b19d3e2ccc14da04fae33e63652ce469b3f2fd': 'GRID',
            '0x107c4504cd79c5d2696ea0030a8dd4e92601b82e': 'BLT',
            '0x7A41e0517a5ecA4FdbC7FbebA4D4c47B9fF6DC63': 'ZSC',
            '0xaf30d2a7e90d7dc361c8c4585e9bb7d2f6f15bc7': '1ST',
            '0xcfb98637bcae43C13323EAa1731cED2B716962fD': 'NET',
            '0xaf4dce16da2877f8c9e00544c93b62ac40631f16': 'MTH',
            '0xfb2f26f266fb2805a387230f2aa0a331b4d96fba': 'DADI',
            '0xBA5F11b16B155792Cf3B2E6880E8706859A8AEB6': 'ARN',
            '0xc27a2f05fa577a83ba0fdb4c38443c0718356501': 'TAU',
            '0xf7b098298f7c69fc14610bf71d5e02c60792894c': 'GUP',
            '0xAa0bb10CEc1fa372eb3Abc17C933FC6ba863DD9E': 'HMC',
            '0x68aa3f232da9bdc2343465545794ef3eea5209bd': 'MSP',
            '0x3137619705b5fc22a3048989f983905e456b59ab': 'EVR',
            '0xd01db73e047855efb414e6202098c4be4cd2423b': 'UQC',
            '0x03806ce5ef69bd9780edfb04c29da1f23db96294': 'TSL',
            '0x4cc19356f2d37338b9802aa8e8fc58b0373296e7': 'KEY',
            '0x0bb217E40F8a5Cb79Adf04E1aAb60E5abd0dfC1e': 'SWFTC',
            '0xea1f346faf023f974eb5adaf088bbcdf02d761f4': 'TIX',
            '0x07e3c70653548B04f0A75970C1F81B4CBbFB606f': 'DLT',
            '0xfec0cf7fe078a500abf15f1284958f22049c2c7e': 'ART',
            '0xcdcfc0f66c522fd086a1b725ea3c0eeb9f9e8814': 'AURA',
            '0xaE73B38d1c9A8b274127ec30160a4927C4d71824': 'STK',
            '0xB70835D7822eBB9426B56543E391846C107bd32C': 'GTC',
            '0x51db5ad35c671a87207d88fc11d593ac0c8415bd': 'MDA',
            '0x6531f133e6deebe7f2dce5a0441aa7ef330b4e53': 'TIME',
            '0x80bc5512561c7f85a3a9508c7df7901b370fa1df': 'TIO',
            '0x7654915a1b82d6d2d0afc37c52af556ea8983c7e': 'IFT',
            '0xdf6ef343350780bf8c3410bf062e0c015b1dd671': 'BMC',
            '0x264Dc2DedCdcbb897561A57CBa5085CA416fb7b4': 'QUN',
            '0xba9d4199fab4f26efe3551d490e3821486f135ba': 'CHSB',
            '0xda6cb58a0d0c01610a29c5a65c303e13e885887c': 'cV',
            '0xe50365f5d679cb98a1dd62d6f6e58e59321bcddf': 'LAToken',
            '0x701c244b988a513c945973defa05de933b23fe1d': 'OAX',
            '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359': 'DAI',
            '0x263c618480dbe35c300d8d5ecda19bbb986acaed': 'MOT',
            '0x1d462414fe14cf489c7a21cac78509f4bf8cd7c0': 'CAN',
            '0x64CdF819d3E75Ac8eC217B3496d7cE167Be42e80': 'IPL',
            '0xe2fb6529ef566a080e6d23de0bd351311087d567': 'COV',
            '0x82b0e50478eeafde392d45d1259ed1071b6fda81': 'DNA',
            '0xac3da587eac229c9896d919abc235ca4fd7f72c1': 'TGT',
            '0x9af4f26941677c706cfecf6d3379ff01bb85d5ab': 'DRT',
            '0x1234567461d3f8db7496581774bd869c83d51c93': 'CAT',
            '0x83984d6142934bb535793a82adb0a46ef0f66b6d': 'REM',
            '0x3d1ba9be9f66b8ee101911bc36d3fb562eac2244': 'RVT',
            '0x226bb599a12c826476e3a771454697ea52e9e220': 'PRO',
            '0x13f11c9905a08ca76e3e853be63d4f0944326c72': 'DIVX',
            '0x27dce1ec4d3f72c3e457cc50354f1f975ddef488': 'AIR',
            '0xa823e6722006afe99e91c30ff5295052fe6b8e32': 'NEU',
            '0xb9e7f8568e08d5659f5d29c4997173d84cdf2607': 'SWT',
            '0x1961b3331969ed52770751fc718ef530838b6dee': 'BDG',
            '0x881ef48211982d01e2cb7092c915e647cd40d85c': 'OTN',
            '0xbdc5bac39dbe132b1e030e898ae3830017d7d969': 'SNOV',
            '0x9e6b2b11542f2bc52f3029077ace37e8fd838d7f': 'HKN',
            '0x29d75277ac7f0335b2165d0895e8725cbf658d73': 'CSNO',
            '0xEA610B1153477720748DC13ED378003941d84fAB': 'ALIS',
            '0x7728dFEF5aBd468669EB7f9b48A7f70a501eD29D': 'PRG',
            '0x45e42D659D9f9466cD5DF622506033145a9b89Bc': 'NxC',
            '0xe3fedaecd47aa8eab6b23227b0ee56f092c967a9': 'PST',
            '0x006BeA43Baa3f7A6f765F14f10A1a1b08334EF45': 'STX',
            '0x9b68bfae21df5a510931a262cecf63f41338f264': 'DBET',
            '0x8ae4bf2c33a8e667de34b54938b0ccd03eb8cc06': 'PTOY',
            '0x671abbe5ce652491985342e85428eb1b07bc6c64': 'QAU',
            '0x2e071D2966Aa7D8dECB1005885bA1977D6038A65': 'ROL',
            '0xc324a2f6b05880503444451b8b27e6f9e63287cb': 'XUC',
            '0x9041Fe5B3FDEA0f5e4afDC17e75180738D877A01': 'PRO',
            '0x52a7cb918c11a16958be40cba7e31e32a499a465': 'fdX',
            '0xfca47962d45adfdfd1ab2d972315db4ce7ccf094': 'IXT',
            '0xff603f43946a3a28df5e6a73172555d8c8b02386': 'RNT',
            '0x999967e2ec8a74b7c8e9db19e039d920b31d39d0': 'TIE',
            '0x43567eb78638A55bbE51E9f9FB5B2D7AD1F125aa': 'HAC',
            '0x4DF812F6064def1e5e029f1ca858777CC98D2D81': 'XAUR',
            '0xb24754be79281553dc1adc160ddf5cd9b74361a4': 'XRL',
            '0x5d51fcced3114a8bb5e90cdd0f9d682bcbcc5393': 'B2BX',
            '0xea5f88e54d982cbb0c441cde4e79bc305e5b43bc': 'PARETO',
            '0xdd6c68bb32462e01705011a4e2ad1a60740f217f': 'HBT',
            '0x9af2c6b1a28d3d6bc084bd267f70e90d49741d5b': 'AXP',
            '0x0affa06e7fbe5bc9a764c979aa66e8256a631f02': 'PLBT',
            '0xa6a840e50bcaa50da017b91a0d86b8b2d41156ee': 'EKO',
            '0x9af839687f6c94542ac5ece2e317daae355493a1': 'HOT',
            '0xa645264C5603E96c3b0B078cdab68733794B0A71': 'MYST',
            '0x3136ef851592acf49ca4c825131e364170fa32b3': 'COFI',
            '0x0f4ca92660efad97a9a70cb0fe969c755439772c': 'LEV',
            '0x4e0603e2a27a30480e5e3a4fe548e29ef12f64be': 'CREDO',
            '0x5b0751713b2527d7f002c0c4e2a37e1219610a6b': 'HORSE',
            '0x8a854288a5976036a725879164ca3e91d30c6a1b': 'GET',
            '0x539efe69bcdd21a83efd9122571a64cc25e0282b': 'BLUE',
            '0x72adadb447784dd7ab1f472467750fc485e4cb2d': 'WRC',
            '0x56ba2Ee7890461f463F7be02aAC3099f6d5811A8': 'CAT',
            '0x5e3346444010135322268a4630d2ed5f8d09446c': 'LOC',
            '0x621d78f2ef2fd937bfca696cabaf9a779f59b3ed': 'DRP',
            '0x85089389c14bd9c77fc2b8f0c3d1dc3363bf06ef': 'SPF',
            '0xd2d6158683aee4cc838067727209a0aaf4359de3': 'BNTY',
            '0x5f53f7a8075614b699baad0bc2c899f4bad8fbbf': 'REBL',
            '0x94298f1e0ab2dfad6eeffb1426846a3c29d98090': 'MyB',
            '0xb6ee9668771a79be7967ee29a63d4184f8097143': 'CXO',
            '0x2fa32a39fc1c399e0cc7b2935868f5165de7ce97': 'PFR',
            '0xf77f4810e7521298a6e2a04f82a6c3492706d74f': 'MEE',
            '0x83eEA00D838f92dEC4D1475697B9f4D3537b56E3': 'VOISE',
            '0xf04a8ac553fcedb5ba99a64799155826c136b0be': 'FLIXX',
            '0x2c82c73d5b34aa015989462b2948cd616a37641f': 'SXUT',
            '0x0d88ed6e74bbfd96b831231638b66c05571e824f': 'AVT',
            '0xeb7c20027172e5d143fb030d50f91cece2d1485d': 'EBTC',
            '0xc8c6a31a4a806d3710a7b38b7b296d2fabccdba8': 'ELIX',
            '0xf0f8b0b8dbb1124261fc8d778e2287e3fd2cf4f5': 'BQ',
            '0x9c23d67aea7b95d80942e3836bcdf7e708a747c2': 'LOCI',
            '0x2604fa406be957e542beb89e6754fcde6815e83f': 'PKT',
            '0x37e8789bb9996cac9156cd5f5fd32599e6b91289': 'AID',
            '0xba2184520a1cc49a6159c57e61e1844e085615b6': 'HGT',
            '0x7d4b8cce0591c9044a22ee543533b72e976e36c3': 'CAG',
            '0xa5f8fc0921880cb7342368bd128eb8050442b1a1': 'ARY',
            '0x79650799e7899a802cb96c0bc33a6a8d4ce4936c': 'AIT',
            '0x923108a439c4e8c2315c4f6521e5ce95b44e9b4c': 'EVE',
            '0xe477292f1b3268687a29376116b0ed27a9c76170': 'PLAY',
            '0x0abefb7611cb3a01ea3fad85f33c3c934f8e2cf4': 'FRD',
            '0x705EE96c1c160842C92c1aeCfCFfccc9C412e3D9': 'POLL',
            '0x687174f8c49ceb7729d925c3a961507ea4ac7b28': 'GAT',
            '0x3839d8ba312751aa0248fed6a8bacb84308e20ed': 'Bez',
            '0xfd8971d5e8e1740ce2d0a84095fca4de729d0c16': 'ZLA',
            '0x8aA33A7899FCC8eA5fBe6A608A109c3893A1B8b2': 'BET',
            '0xf70a642bd387f94380ffb90451c2c81d4eb82cbc': 'STAR',
            '0x1063ce524265d5a3a624f4914acd573dd89ce988': 'AIX',
            '0x74ceda77281b339142a36817fa5f9e29412bab85': 'ERO',
            '0x17fd666fa0784885fa1afec8ac624d9b7e72b752': 'FLIK',
            '0x519475b31653e46d20cd09f9fdcf3b12bdacb4f5': 'VIU',
            '0x24ddff6d8b8a42d835af3b440de91f3386554aa4': 'ING',
            '0xac3211a5025414af2866ff09c23fc18bc97e79b1': 'DOV',
            '0x9720b467a710382A232a32F540bDCed7d662a10B': 'VZT',
            '0xa7f976c360ebbed4465c2855684d1aae5271efa9': 'TFL',
            '0x2ae965cd3d2b6d186e87d9586fc3bdbfc667cacc': 'GJC',
            '0x0ebb614204e47c09b6c3feb9aaecad8ee060e23e': 'CPAY',
            '0xAef38fBFBF932D1AeF3B808Bc8fBd8Cd8E1f8BC5': 'CRB',
            '0x2baac9330cf9ac479d819195794d79ad0c7616e3': 'ADB',
            '0x1b22c32cd936cb97c28c5690a0695a82abf688e6': 'WISH',
            '0x4355fC160f74328f9b383dF2EC589bB3dFd82Ba0': 'OPT',
            '0x55648de19836338549130b1af587f16bea46f66b': 'PBL',
            '0xb3bd49e28f8f832b8d1e246106991e546c323502': 'GMT',
            '0xb62d18dea74045e822352ce4b3ee77319dc5ff2f': 'EVC',
            '0x93e682107d1e9defb0b5ee701c71707a4b2e46bc': 'MCAP',
            '0x7d3e7d41da367b4fdce7cbe06502b13294deb758': 'SSS',
            '0xcc34366e3842ca1bd36c1f324d15257960fcc801': 'BON',
            '0xa8006c4ca56f24d6836727d106349320db7fef82': 'INXT',
            '0xd7631787b4dcc87b1254cfd1e5ce48e96823dee8': 'SCL',
            '0x30cecb5461a449a90081f5a5f55db4e048397bab': 'TRCT',
            '0x672a1ad4f667fb18a333af13667aa0af1f5b5bdd': 'CRED',
            '0x9002d4485b7594e3e850f0a206713b305113f69e': 'HAT',
            '0x422866a8F0b032c5cf1DfBDEf31A20F4509562b0': 'ADST',
            '0x9214ec02cb71cba0ada6896b8da260736a67ab10': 'REAL',
            '0xf6cfe53d6febaeea051f400ff5fc14f0cbbdaca1': 'DGPT',
            '0xff18dbc487b4c2e3222d115952babfda8ba52f5f': 'LIFE',
            '0x78b7fada55a64dd895d8c8c35779dd8b67fa8a05': 'ATL',
            '0xd3c00772b24d997a812249ca637a921e81357701': 'WILD',
            '0xea097a2b1db00627b2fa17460ad260c016016977': 'UFR',
            '0xf8e386eda857484f5a12e4b5daa9984e06e73705': 'IND',
            '0x39013f961c378f02c2b82a6e1d31e9812786fd9d': 'SMS',
            '0x1183f92a5624d68e85ffb9170f16bf0443b4c242': 'QVT',
            '0xe81d72d14b1516e68ac3190a46c93302cc8ed60f': 'CL',
            '0x8b1f49491477e0fb46a29fef53f1ea320d13c349': 'AMM',
            '0xaE616e72D3d89e847f74E8ace41Ca68bbF56af79': '∞',
            '0x0371a82e4a9d0a4312f3ee2ac9c6958512891372': 'STU',
            '0x1b9743f556d65e757c4c650b4555baf354cb8bd3': 'ETBS',
            '0x88FCFBc22C6d3dBaa25aF478C578978339BDe77a': 'FYN',
            '0xd341d1680eeee3255b8c4c75bcce7eb57f144dae': 'ONG',
            '0x7703C35CfFdC5CDa8D27aa3df2F9ba6964544b6e': 'PYLNT',
            '0x8f0921f30555624143d427b340b1156914882c10': 'FYP',
            '0xE814aeE960a85208C3dB542C53E7D4a6C8D5f60F': 'DAY',
            '0x1a986F1659e11E2AE7CC6543F307bAE5cDe1C761': 'UNI',
            '0x386467f1f3ddbe832448650418311a479eecfc57': 'EMB',
            '0x05c7065d644096a4e4c3fe24af86e36de021074b': 'LCT',
            '0x46492473755e8df960f8034877f61732d718ce96': 'STRC',
            '0x2bdc0d42996017fce214b21607a515da41a9e0c5': 'SKIN',
            '0x5121e348e897daef1eef23959ab290e5557cf274': 'AI',
            '0x0835ecd15ddf08d4786304d71b4672dc5c40f011': 'PLC',
            '0xe8a1df958be379045e2b46a31a98b93a2ecdfded': 'ESZ',
            '0x13f1b7fdfbe1fc66676d56483e21b1ecb40b58e2': 'ACC',
            '0x50ee674689d75c0f88e8f83cfe8c4b69e8fd590d': 'EPY',
            '0x44197a4c44d6a059297caf6be4f7e172bd56caaf': 'ELTCOIN',
            '0x6fff3806bbac52a20e0d79bc538d527f6a22c96b': 'CDX',
            '0x59061b6f26BB4A9cE5828A19d35CFD5A4B80F056': 'LGD',
            '0x1245ef80f4d9e02ed9425375e8f649b9221b31d8': 'ARCT',
            '0xAb16E0d25c06CB376259cc18C1de4ACA57605589': 'FUCK',
            '0xd5527579226e4ebc8864906e49d05d4458ccf47f': 'KBR',
            '0x63b992e6246d88f07fc35a056d2c365e6d441a3d': 'SCT',
            '0x27f610bf36eca0939093343ac28b1534a721dbb4': 'WAND',
            '0xcced5b8288086be8c38e23567e684c3740be4d48': 'RLT',
            '0x5d21ef5f25a985380b65c8e943a0082feda0db84': 'ECASH',
            '0xe120c1ecbfdfea7f0a8f0ee30063491e8c26fedf': 'SUR',
            '0xa54ddc7b3cce7fc8b1e3fa0256d0db80d2c10970': 'NDC',
            '0x47dd62d4d075dead71d0e00299fc56a2d747bebb': 'EQL',
            '0xCB5A05beF3257613E984C17DbcF039952B6d883F': 'SGR',
            '0x8727c112c712c4a03371ac87a74dd6ab104af768': 'JET',
            '0x06147110022b768ba8f99a8f385df11a151a9cc8': 'ACE',
            '0xeee2d00eb7deb8dd6924187f5aa3496b7d06e62a': 'TIG',
            '0x662aBcAd0b7f345AB7FfB1b1fbb9Df7894f18e66': 'CTX',
            '0x6ccb56947ea1d6efdc81acfbacd8263ddfa9b202': 'RKC',
            '0x2dAEE1AA61D60A252DC80564499A69802853583A': 'ATS',
            '0x1a95b271b0535d15fa49932daba31ba612b52946': 'MNE',
            '0x859a9c0b44cb7066d956a958b0b82e54c9e44b4b': 'iETH',
            '0x6aac8cb9861e42bf8259f5abdc6ae3ae89909e11': 'BTCR',
            '0xafc39788c51f0c1ff7b55317f3e70299e521fff6': 'eBCH',
            '0x49aec0752e68d0282db544c677f6ba407ba17ed7': 'XBL',
            '0x14839bf22810F09fb163AF69BD21Bd5476F445Cd': 'CFD',
            '0xcc4ef9eeaf656ac1a2ab886743e98e97e090ed38': 'DDF',
            '0x814964b1bceaf24e26296d031eadf134a2ca4105': 'NEWB',
            '0x8a99ed8a1b204903ee46e733f2c1286f6d20b177': 'NTO',
            '0x336f646f87d9f6bc6ed42dd46e8b3fd9dbd15c22': 'CCT',
            '0x73b534fb6f07381a29a60b01eed5ae57d4ee24d7': 'SDRN',
            '0x994f0dffdbae0bbf09b652d6f11a493fd33f42b9': 'EAGLE',
            '0xee609fe292128cad03b786dbb9bc2634ccdbe7fc': 'POS',
            '0x26d5bd2dfeda983ecd6c39899e69dae6431dffbb': 'ERC',
            '0x180e5087935a94fd5bbab00fd2249c5be0473381': 'ZCG',
            '0x9e77d5a1251b6f7d456722a6eac6d2d5980bd891': 'BRAT',
            '0x7Dc4f41294697a7903C4027f6Ac528C5d14cd7eB': 'RMC',
            '0x0766e79a6fd74469733e8330b3b461c0320ff059': 'EXN',
            '0xe469c4473af82217b30cf17b10bcdb6c8c796e75': 'EXRN',
            '0xffe8196bc259e8dedc544d935786aa4709ec3e64': 'HDG',
            '0xD8912C10681D8B21Fd3742244f44658dBA12264E': 'PLU',
            '0xab95e915c123fded5bdfb6325e35ef5515f1ea69': 'XNN',
            '0x3adfc4999f77d04c8341bac5f3a76f58dff5b37a': 'PRIX',
            '0x1500205f50bf3fd976466d0662905c9ff254fc9c': 'BBT',
            '0xf05a9382A4C3F29E2784502754293D88b835109C': 'REX',
            '0x089a6d83282fb8988a656189f1e7a73fa6c1cac2': 'PGL',
            '0xe64509f0bf07ce2d29a7ef19a8a9bc065477c1b4': 'PIPL',
            '0xB802b24E0637c2B87D2E8b7784C055BBE921011a': 'EMV',
            '0x0b1724cc9fda0186911ef6a75949e9c0d3f0f2f3': 'RIYA',
            '0xf3d29fb98d2dc5e78c87198deef99377345fd6f1': 'BIP',
            '0x0aef06dcccc531e581f0440059e6ffcc206039ee': 'ITT',
            '0x7D5Edcd23dAa3fB94317D32aE253eE1Af08Ba14d': 'EBET',
            '0xe2e6d4be086c6938b53b22144855eef674281639': 'LNK',
            '0xb45a50545beeab73f38f31e5973768c421805e5e': 'TKR',
            '0x679badc551626e01b23ceecefbc9b877ea18fc46': 'CCO',
            '0x07d9e49ea402194bf48a8276dafb16e4ed633317': 'DALC',
            '0xaec98a708810414878c3bcdf46aad31ded4a4557': '300',
            '0xCA29db4221c111888a7e80b12eAc8a266Da3Ee0d': 'BLN',
            '0x33f90Dee07c6E8B9682dD20F73E6C358B2ED0f03': 'TRDT',
            '0x2a05d22db079bc40c2f77a1d1ff703a56e631cc1': 'BAS',
            '0x5a84969bb663fb64F6d015DcF9F622Aedc796750': 'ICE',
            '0x2233799ee2683d75dfefacbcd2a26c78d34b470d': 'NTWK',
            '0x5046e860ff274fb8c66106b0ffb8155849fb0787': 'JS',
            '0x27f706edde3aD952EF647Dd67E24e38CD0803DD6': 'UET',
            '0x0743392132d1a03a902c477e5a176f256ba3220c': 'CTIC3',
            '0x9653cfd0865ad8313bea2f0c2ec0584bfd05115b': 'FXE',
            '0xbab165df9455aa0f2aed1f2565520b91ddadb4c8': 'EKT',
            '0x809826cceab68c387726af962713b64cb5cb3cca': 'nCash',
            '0xEda8B016efA8b1161208Cf041cD86972eeE0F31E': 'IHT',
            '0xf278c1ca969095ffddded020290cf8b5c424ace2': 'RUFF',
            '0x8dd5fbce2f6a956c3022ba3663759011dd51e73e': 'TUSD',
            '0x584b44853680ee34a0f337b712a8f66d816df151': 'AIDOC',
            '0x5b26c5d0772e5bbac8b3182ae9a13f9bb2d03765': 'EDU',
            '0x622dFfCc4e83C64ba959530A5a5580687a57581b': 'AUTO',
            '0x5a1a29dbb6ad6153db764568c1289076bc876df6': 'NKC',
            '0x45245bc59219eeaaf6cd3f382e078a461ff9de7b': 'BKX',
            '0x0af44e2784637218dd1d32a322d44e603a8f0c6a': 'MTX',
            '0x55f93985431fc9304077687a35a1ba103dc1e081': 'SMT',
            '0x6ec8a24cabdc339a06a172f8223ea557055adaa5': 'GNX',
            '0x358d12436080a01a16f711014610f8a4c2c2d233': 'PXS',
            '0x106aa49295b525fcf959aa75ec3f7dcbf5352f1c': 'RKT',
            '0x653430560be843c4a3d143d0110e896c2ab8ac0d': 'MOF',
            '0xd7cddd45629934c2f6ed3b63217bd8085d7c14a8': 'AVH',
            '0x408e41876cccdc0f92210600ef50372656052a38': 'REN',
            '0xd0929d411954c47438dc1d871dd6081f5c5e149c': 'RFR',
            '0x13f25cd52b21650caa8225C9942337d914C9B030': 'RCT',
            '0xd0352a019e9ab9d757776f532377aaebd36fd541': 'FSN',
            '0xc7bba5b765581efb2cdd2679db5bea9ee79b201f': 'GEM',
            '0x43ee79e379e7b78d871100ed696e803e7893b644': 'UGT',
            '0xe25bcec5d3801ce3a794079bf94adf1b8ccd802d': 'MAN',
            '0xCBcE61316759D807c474441952cE41985bBC5a40': 'MOAC',
            '0x9e3319636e2126e3c0bc9e3134AEC5e1508A46c7': 'UTNP',
            '0x13d0bf45e5f319fa0b58900807049f23cae7c40d': 'READ',
            '0x9F5F3CFD7a32700C93F971637407ff17b91c7342': 'DDD',
            '0x51ee82641ac238bde34b9859f98f5f311d6e4954': 'IQT',
            '0x4290563c2d7c255b5eec87f2d3bd10389f991d68': 'UIP',
            '0xf83301c5cd1ccbb86f466a6b3c53316ed2f8465a': 'CMS',
            '0xd780ae2bf04cd96e577d3d014762f831d97129d0': 'EVN',
            '0xc7579bb99af590ec71c316e1ac4436c535039594': 'BAR',
            '0x57ad67acf9bf015e4820fbd66ea1a21bed8852ec': 'LYM',
            '0x78b039921e84e726eb72e7b1212bb35504c645ca': 'SETH',
            '0x4d8fc1453a0f359e99c9675954e656d80d996fbf': 'BEE',
            '0x5e6016ae7d7c49d347dcf834860b9f3ee282812b': 'EZT',
            '0x6425c6be902d692ae2db752b3c268afadb099d3b': 'MWAT',
            '0xc72fe8e3dd5bef0f9f31f259399f301272ef2a2d': 'INSTAR',
            '0x5c743a35e903f6c584514ec617acee0611cf44f3': 'EXY',
            '0x461733c17b0755ca5649b6db08b3e213fcf22546': 'ATN',
            '0x1e797Ce986C3CFF4472F7D38d5C4aba55DfEFE40': 'BCDN',
            '0x4270bb238f6dd8b1c3ca01f96ca65b2647c06d3c': 'FOTA',
            '0xbc86727e770de68b1060c91f6bb6945c73e10388': 'XNK',
            '0x647f274b3a7248d6cf51b35f08e7e7fd6edfb271': 'MAG',
            '0x622cd54deb2bb7a051515192417109bcf3fe098f': 'IPC',
            '0x69beab403438253f13b6e92db91f7fb849258263': 'NTK',
            '0x4824a7b64e3966b0133f4f4ffb1b9d6beb75fff7': 'TCT',
            '0x2ccbff3a042c68716ed2a2cb0c544a9f1d1935e1': 'DMT',
            '0xf44745fbd41f6a1ba151df190db0564c5fcc4410': 'CPY',
            '0xe8780b48bdb05f928697a5e8155f672ed91462f7': 'CAS',
            '0x3a92bd396aef82af98ebc0aa9030d25a23b11c6b': 'TBX',
            '0xb110ec7b1dcb8fab8dedbf28f53bc63ea5bedd84': 'XID',
            '0x8db54ca569d3019a2ba126d03c37c44b5ef81ef6': 'DXT',
            '0xb17df9a3b09583a9bdcf757d6367171476d4d8a3': 'MVC',
            '0xe30e02f049957e2a5907589e06ba646fb2c321ba': 'DRPU',
            '0x86949dc8043a5fd7619a1289d65964ad5ec3d25c': 'GCS',
            '0x6781a0f84c7e9e846dcb84a9a5bd49333067b104': 'ZAP',
            '0xcc13fc627effd6e35d2d2706ea3c4d7396c610ea': 'IDXM',
            '0x71D01dB8d6a2fBEa7f8d434599C237980C234e4C': 'GLA',
            '0xec46f8207d766012454c408de210bcbc2243e71c': 'NOX',
            '0x65a15014964f2102ff58647e16a16a6b9e14bcf6': 'OX',
            '0x3293cc907fde439b39aedaf1b982785adaff186b': 'TRIA',
            '0xc3951d77737733174152532e8b0f27e2c4e9f0dc': 'CLD',
            '0x138a8752093f4f9a79aaedf48d4b9248fab93c9c': 'MCI',
            '0x0f598112679b78e17a4a9febc83703710d33489c': 'XMRG',
            '0x7e9e99f059bb84298332b63be6f882a73120b9fb': 'MCR',
            '0x02725836ebf3ecdb1cdf1c7b02fcbbfaa2736af8': 'BTCA',
            '0x5e4abe6419650ca839ce5bb7db422b881a6064bb': 'WiC',
            '0x219218f117dc9348b358b8471c55a073e5e0da0b': 'GRX',
            '0x036407F23D5E1C1486F7488332CF54bf06E5F09F': 'ABC',
            '0xe8c09672cfb9cfce6e2edbb01057d9fa569f97c1': 'INDI',
            '0x16f812be7fff02caf662b85d5d58a5da6572d4df': 'UTT',
            '0x6745fab6801e376cd24f03572b9c9b0d4edddccf': 'SENSE',
            '0xa9aad2dc3a8315caeee5f458b1d8edc31d8467bd': 'BTCM',
            '0xb3203DB25a01fa7950a860B42b899Ad7Da52DDD6': 'PLX',
            '0xA0aa85b54F8A7b09C845F13a09172B08925f3d54': 'SISA',
            '0x0a76aad21948ea1ef447d26dee91a54370e151e0': 'ELITE',
            '0xf333b2ace992ac2bbd8798bf57bc65a06184afba': 'SND',
            '0x6733d909e10ddedb8d6181b213de32a30ceac7ed': 'BTE',
            '0xbdcfbf5c4d91abc0bc9709c7286d00063c0e6f22': 'GUESS',
            '0xe0c72452740414d861606a44ccd5ea7f96488278': 'ETT',
            '0x8d5a69dc82a47594881256f2eef81770274fa30f': 'NTC',
            '0xad6714bd97cbbd29788f8838bc865ee71b843eb8': 'HDLB',
            '0x6467882316dc6e206feef05fba6deaa69277f155': 'FAP',
            '0x6025f65f6b2f93d8ed1efedc752acfd4bdbcec3e': 'EGOLD',
            '0x6d5cac36c1ae39f41d52393b7a425d0a610ad9f2': 'LLT',
            '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',

        };
    }
};
