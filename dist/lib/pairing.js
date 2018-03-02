"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const srp = require("fast-srp-hap");
const protobufjs_1 = require("protobufjs");
const path = require("path");
const crypto = require("crypto");
const ed25519 = require("ed25519");
const credentials_1 = require("./credentials");
const tlv_1 = require("./util/tlv");
const encryption_1 = require("./util/encryption");
class Pairing {
    constructor(device) {
        this.device = device;
        this.key = crypto.randomBytes(32);
    }
    initiatePair(log) {
        let that = this;
        return protobufjs_1.load(path.resolve(__dirname + "/protos/CryptoPairingMessage.proto"))
            .then(root => {
            let type = root.lookupType('CryptoPairingMessage');
            let tlvData = tlv_1.default.encode(tlv_1.default.Tag.PairingMethod, 0x00, tlv_1.default.Tag.Sequence, 0x01);
            let message = type.create({
                status: 0,
                pairingData: tlvData
            });
            return that.device
                .sendMessage(message);
        })
            .then(message => {
            let pairingData = message['pairingData'];
            let tlvData = tlv_1.default.decode(pairingData);
            that.deviceSalt = tlvData[tlv_1.default.Tag.Salt];
            that.devicePublicKey = tlvData[tlv_1.default.Tag.PublicKey];
            if (that.deviceSalt.byteLength != 16) {
                throw new Error(`salt must be 16 bytes (but was ${that.deviceSalt.byteLength})`);
            }
            if (that.devicePublicKey.byteLength !== 384) {
                throw new Error(`serverPublicKey must be 384 bytes (but was ${that.devicePublicKey.byteLength})`);
            }
            return Promise.resolve((pin) => {
                return that.completePairing(log, pin);
            });
        });
    }
    completePairing(log, pin) {
        this.srp = srp.Client(srp.params['3072'], this.deviceSalt, Buffer.from('Pair-Setup'), Buffer.from(pin), this.key);
        this.srp.setB(this.devicePublicKey);
        this.publicKey = this.srp.computeA();
        this.proof = this.srp.computeM1();
        log("DEBUG: Client Public Key=" + this.publicKey.toString('hex') + "\nProof=" + this.proof.toString('hex'));
        let that = this;
        return protobufjs_1.load(path.resolve(__dirname + "/protos/CryptoPairingMessage.proto"))
            .then(root => {
            let type = root.lookupType('CryptoPairingMessage');
            let tlvData = tlv_1.default.encode(tlv_1.default.Tag.Sequence, 0x03, tlv_1.default.Tag.PublicKey, that.publicKey, tlv_1.default.Tag.Proof, that.proof);
            let message = type.create({
                status: 0,
                pairingData: tlvData
            });
            return that.device
                .sendMessage(message)
                .then(message => {
                let pairingData = message["pairingData"];
                that.deviceProof = tlv_1.default.decode(pairingData)[tlv_1.default.Tag.Proof];
                log("DEBUG: Device Proof=" + that.deviceProof.toString('hex'));
                that.srp.checkM2(that.deviceProof);
                let seed = crypto.randomBytes(32);
                let keyPair = ed25519.MakeKeypair(seed);
                let privateKey = keyPair.privateKey;
                let publicKey = keyPair.publicKey;
                let sharedSecret = that.srp.computeK();
                let deviceHash = encryption_1.default.HKDF("sha512", Buffer.from("Pair-Setup-Controller-Sign-Salt"), sharedSecret, Buffer.from("Pair-Setup-Controller-Sign-Info"), 32);
                let deviceInfo = Buffer.concat([deviceHash, Buffer.from(that.device.pairingId), publicKey]);
                let deviceSignature = ed25519.Sign(deviceInfo, privateKey);
                let encryptionKey = encryption_1.default.HKDF("sha512", Buffer.from("Pair-Setup-Encrypt-Salt"), sharedSecret, Buffer.from("Pair-Setup-Encrypt-Info"), 32);
                let tlvData = tlv_1.default.encode(tlv_1.default.Tag.Username, Buffer.from(that.device.pairingId), tlv_1.default.Tag.PublicKey, publicKey, tlv_1.default.Tag.Signature, deviceSignature);
                let encryptedTLV = Buffer.concat(encryption_1.default.encryptAndSeal(tlvData, null, Buffer.from('PS-Msg05'), encryptionKey));
                log("DEBUG: Encrypted Data=" + encryptedTLV.toString('hex'));
                let outerTLV = tlv_1.default.encode(tlv_1.default.Tag.Sequence, 0x05, tlv_1.default.Tag.EncryptedData, encryptedTLV);
                let nextMessage = type.create({
                    status: 0,
                    pairingData: outerTLV
                });
                return that.device
                    .sendMessage(nextMessage)
                    .then(message => {
                    let encryptedData = tlv_1.default.decode(message["pairingData"])[tlv_1.default.Tag.EncryptedData];
                    let cipherText = encryptedData.slice(0, -16);
                    let hmac = encryptedData.slice(-16);
                    let decrpytedData = encryption_1.default.verifyAndDecrypt(cipherText, hmac, null, Buffer.from('PS-Msg06'), encryptionKey);
                    let tlvData = tlv_1.default.decode(decrpytedData);
                    that.device.credentials = new credentials_1.Credentials(that.device.uid, tlvData[tlv_1.default.Tag.Username], that.device.pairingId, tlvData[tlv_1.default.Tag.PublicKey], seed);
                    return that.device;
                });
            });
        });
    }
}
exports.Pairing = Pairing;