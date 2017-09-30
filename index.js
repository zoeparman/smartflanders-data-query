const Rx = require('rx');
const ldfetch = require('ldfetch');
const moment = require('moment');
const lodash = require('lodash');
const n3 = require('n3');
const thr = require('throw');

const pdi = require('./parking-data-interval.js');
const util = require('./util.js');

class SmartflandersDataQuery {
    constructor() {
        this.fetch = new ldfetch();
        this._catalog = [];
        this._rangegates = {};
        this.buildingBlocks = {
            oDcatDataset: 'http://www.w3.org/ns/dcat#Dataset',
            oDatexUrbanParkingSite: 'http://vocab.datex.org/terms#UrbanParkingSite',
            pDatexParkingNumberOfSpaces: 'http://vocab.datex.org/terms#parkingNumberOfSpaces',
            pRdfsLabel: 'http://www.w3.org/2000/01/rdf-schema#label',
            pDcatDistribution: 'http://www.w3.org/ns/dcat#distribution',
            pDcatDownloadUrl: 'http://www.w3.org/ns/dcat#downloadURL',
            pRdfType: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            mdiHasRangegate: 'http://semweb.datasciencelab.be/ns/multidimensional-interface/hasRangeGate'
        }
    }

    // Interprets a DCAT catalog and saves download links
    // Returns a promise that resolves when the catalog was added
    addCatalog(catalog) {
        return this.fetch.get(catalog).then(response => {
            // Get datasets
            let datasets = util.filterTriples({
                predicate: this.buildingBlocks.pRdfType,
                object: this.buildingBlocks.oDcatDataset
            }, response.triples);

            // Get their distributions
            let distributions = [];
            datasets.forEach(d => {
                distributions = distributions.concat(util.filterTriples({
                    subject: d.subject,
                    predicate: this.buildingBlocks.pDcatDistribution
                }, response.triples));
            });

            // Get any rangegates (MDI entry points)
            datasets.forEach(d => {
                util.filterTriples({
                    subject: d.subject,
                    predicate: this.buildingBlocks.mdiHasRangegate
                }).forEach(t => {
                    this._rangegates[d.subject] = t.object;
                });
            });

            // Get their download links
            let downlinks = [];
            distributions.forEach(d => {
                downlinks = downlinks.concat(util.filterTriples({
                    subject: d.object,
                    predicate: this.buildingBlocks.pDcatDownloadUrl
                }, response.triples));
            });

            // Add links to catalog
            downlinks.forEach(dl => {
                if (this._catalog.indexOf(dl.object) === -1) {
                    this._catalog.push(dl.object);
                }
            });
        });
    }

    // Adds a simple dataset URL to the internal catalog
    addDataset(dataset) {
        if (this._catalog.indexOf(dataset) === -1) {
            this._catalog.push(dataset);
        }
    }

    // Adds an MDI entry point for a certain dataset
    addMDIEntry(dataset, rangegate) {
        if (this._catalog.includes(dataset)) {
            this._rangegates[dataset] = rangegate;
        } else {
            thr('Dataset URL not found in internal catalog: ' + dataset);
        }
    }

    // Gets parkings from all datasets in catalog
    // Returns an Observable
    getParkings() {
        return Rx.Observable.create(observer => {
            let barrier = {};
            this._catalog.forEach(url => barrier[url] = false);
            this._catalog.forEach(datasetUrl => {
                // If we have an MDI entry point, use that one
                if (this._rangegates[datasetUrl] !== undefined) {
                    datasetUrl = this._rangegates[datasetUrl];
                }
                this.fetch.get(datasetUrl).then(response => {
                    // Get all subjects that are parkings
                    const parkings = util.filterTriples({object: this.buildingBlocks.oDatexUrbanParkingSite}, response.triples);
                    const totalspaces = util.filterTriples({predicate: this.buildingBlocks.pDatexParkingNumberOfSpaces}, response.triples);
                    const labels = util.filterTriples({predicate: this.buildingBlocks.pRdfsLabel}, response.triples);
                    if (parkings.length <= 0) {
                        observer.onError('No parkings found in dataset: ', datasetUrl);
                    }
                    parkings.forEach(parking => {
                        const totalspacesresult = lodash.find(totalspaces, (o) => o.subject === parking.subject);
                        const totalspacesParking = parseInt(n3.Util.getLiteralValue(totalspacesresult.object), 10);
                        const labelresult = lodash.find(labels, (o) => {
                            return o.subject === parking.subject
                        });
                        const rdfslabel = n3.Util.getLiteralValue(labelresult.object);
                        const id = rdfslabel.replace(' ', '-').toLowerCase();
                        const parkingObj = {
                            label: rdfslabel,
                            uri: parking.subject,
                            id: id,
                            totalSpaces: totalspacesParking,
                            datasetUrl: datasetUrl,
                        };
                        observer.onNext(parkingObj);
                    });
                    barrier[datasetUrl] = true;
                    let finished = true;
                    Object.keys(barrier).forEach(key => {
                        if (barrier[key] === false) finished = false
                    });
                    if (finished) {
                        observer.onCompleted();
                    }
                }).catch(error => {
                    barrier[datasetUrl] = true;
                    let finished = true;
                    Object.keys(barrier).forEach(key => {
                        if (barrier[key] === false) finished = false
                    });
                    if (finished) {
                        observer.onCompleted();
                    }
                });
            });
        });
    }


    // TODO use MDI here if possible!
    // Gets an interval of data for the entire catalog
    // Returns an observable
    getInterval(from, to) {
        let barrier = {};
        this._catalog.forEach(url => barrier[url] = false);

        return Rx.Observable.create(observer => {
            this._catalog.forEach(dataset => {
                const entry = dataset + '?time=' + moment.unix(to).format('YYYY-MM-DDTHH:mm:ss');
                new pdi(from, to, entry).fetch().subscribe(meas => {
                    observer.onNext(meas);
                }, (error) => observer.onError(error), () => {
                    barrier[dataset] = true;
                    let done = true;
                    Object.keys(barrier).forEach(key => {
                        if (!barrier[key]) {
                            done = false;
                        }
                    });
                    if (done) observer.onCompleted();
                })
            })
        })
    }

    // Gets an interval of data for a dataset
    // Returns an Observable
    getDatasetInterval(from, to, datasetUrl) {
        const entry = datasetUrl + '?time=' + moment.unix(to).format('YYYY-MM-DDTHH:mm:ss');
        return new pdi(from, to, entry).fetch();
    }

    // Gets an interval of data for one parking
    // Returns an Observable
    getParkingInterval(from, to, datasetUrl, uri) {
        const entry = datasetUrl + '?time=' + moment.unix(to).format('YYYY-MM-DDTHH:mm:ss');
        return Rx.Observable.create(observer => {
            new pdi(from, to, entry).fetch().subscribe(meas => {
                if (meas.parkingUrl === uri) {
                    observer.onNext(meas);
                }
            }, (error) => observer.onError(error), () => observer.onCompleted());
        });
    }

    getCatalog() {
        return this._catalog;
    }
}

module.exports = SmartflandersDataQuery;
