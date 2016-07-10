import React from 'react';

const Roll = React.createClass({

	getDefaultProps() {
		return {
			label: ''
		}
	},

	render(){
		return (
			<div className="roll" onClick={this.props.addToTotal.bind(null, this.props.total)}>
				<div>
					<h2>{this.props.label}</h2>
					<div className="roll__dice">{this.props.children}</div>
				</div>
				<div className="roll__total"><span>{this.props.total}</span></div>
			</div>
		);
	}

});

export default Roll;
