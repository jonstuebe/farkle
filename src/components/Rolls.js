import React, { PropTypes } from 'react'

import Roll from './Roll';
import Die from './Die';

const Rolls = React.createClass({
    render () {
        return (
            <div>
                <Roll label="Single 1" total="100" addToTotal={this.props.addToTotal}>
                    <Die num={1} />
                </Roll>
                <Roll label="Single 5" total="50" addToTotal={this.props.addToTotal}>
                    <Die num={5} />
                </Roll>
                <Roll label="Three 1's" total="300" addToTotal={this.props.addToTotal}>
                    <Die num={1} />
                    <Die num={1} />
                    <Die num={1} />
                </Roll>
                <Roll label="Three 2's" total="200" addToTotal={this.props.addToTotal}>
                    <Die num={2} />
                    <Die num={2} />
                    <Die num={2} />
                </Roll>
                <Roll label="Three 3's" total="300" addToTotal={this.props.addToTotal}>
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={3} />
                </Roll>
                <Roll label="Three 4's" total="400" addToTotal={this.props.addToTotal}>
                    <Die num={4} />
                    <Die num={4} />
                    <Die num={4} />
                </Roll>
                <Roll label="Three 5's" total="500" addToTotal={this.props.addToTotal}>
                    <Die num={5} />
                    <Die num={5} />
                    <Die num={5} />
                </Roll>
                <Roll label="Three 6's" total="600" addToTotal={this.props.addToTotal}>
                    <Die num={6} />
                    <Die num={6} />
                    <Die num={6} />
                </Roll>
                <Roll label="Four of any kind" total="1000" addToTotal={this.props.addToTotal}>
                    <Die num={6} />
                    <Die num={6} />
                    <Die num={6} />
                    <Die num={6} />
                </Roll>
                <Roll label="Five of any kind" total="2000" addToTotal={this.props.addToTotal}>
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={3} />
                </Roll>
                <Roll label="Six of any kind" total="3000" addToTotal={this.props.addToTotal}>
                    <Die num={5} />
                    <Die num={5} />
                    <Die num={5} />
                    <Die num={5} />
                    <Die num={5} />
                    <Die num={5} />
                </Roll>
                <Roll label="1-6 straight" total="1500" addToTotal={this.props.addToTotal}>
                    <Die num={1} />
                    <Die num={2} />
                    <Die num={3} />
                    <Die num={4} />
                    <Die num={5} />
                    <Die num={6} />
                </Roll>
                <Roll label="Three pairs" total="1500" addToTotal={this.props.addToTotal}>
                    <Die num={1} />
                    <Die num={1} />
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={4} />
                    <Die num={4} />
                </Roll>
                <Roll label="Four of any number with a pair" total="1500" addToTotal={this.props.addToTotal}>
                    <Die num={2} />
                    <Die num={2} />
                    <Die num={4} />
                    <Die num={4} />
                    <Die num={4} />
                    <Die num={4} />
                </Roll>
                <Roll label="Two triplets" total="2500" addToTotal={this.props.addToTotal}>
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={3} />
                    <Die num={6} />
                    <Die num={6} />
                    <Die num={6} />
                </Roll>
            </div>
        )
    }
})

export default Rolls
